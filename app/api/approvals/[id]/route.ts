import { and, eq } from 'drizzle-orm';
import { route } from '@/lib/api/handler';
import { ok } from '@/lib/api/responses';
import { approvalDecisionSchema } from '@/lib/api/schemas';
import { approvalRequests } from '@/lib/db/schema';
import { recordAudit } from '@/lib/audit';
import { adjustWallet, topUpUser } from '@/lib/services/wallet';
import { refundPurchase } from '@/lib/services/refunds';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';

/**
 * Decide a parked high-value request.
 *
 * Two-person control: the approver must not be the requester. That is checked
 * here for a clean error, and again by a CHECK constraint on the table, so it
 * holds even if this code is bypassed.
 */
export const POST = route(
  { permission: 'approval.decide', body: approvalDecisionSchema, idempotent: true },
  async ({ context, body, params, idempotencyKey }) => {
    const approvalId = params.id;
    if (!approvalId) throw new ValidationError('An approval id is required.');

    const [request] = await context.db
      .select()
      .from(approvalRequests)
      .where(
        and(eq(approvalRequests.id, approvalId), eq(approvalRequests.eventId, context.eventId)),
      )
      .limit(1);
    if (!request) throw new NotFoundError('That approval request');

    if (request.status !== 'PENDING_APPROVAL') {
      throw new ConflictError('This request has already been decided.', 'already_decided');
    }
    if (request.requestedBy === context.actor.userId) {
      throw new ForbiddenError('You cannot approve your own request.');
    }

    if (body.decision === 'REJECTED') {
      await context.db
        .update(approvalRequests)
        .set({
          status: 'REJECTED',
          decidedBy: context.actor.userId,
          decidedAt: new Date(),
          decisionNote: body.note ?? null,
        })
        .where(eq(approvalRequests.id, approvalId));

      await recordAudit(context.db, {
        ...context.audit,
        action: 'approval.rejected',
        targetType: 'approval_request',
        targetId: approvalId,
        after: { decision: 'REJECTED', note: body.note },
      });

      return ok({ id: approvalId, status: 'REJECTED' });
    }

    const payload = request.payload as Record<string, unknown>;
    let resultReferenceType: string | null = null;
    let resultReferenceId: string | null = null;

    // `preApproved` stops the executed operation from parking itself again.
    switch (request.type) {
      case 'LARGE_TOP_UP': {
        const { result } = await topUpUser(
          context.db,
          {
            eventId: context.eventId,
            userId: String(payload.userId),
            amountPoints: Number(payload.amountPoints),
            reason: request.reason,
            createdBy: request.requestedBy,
            preApproved: true,
          },
          `approval-${approvalId}`,
          context.audit,
        );
        resultReferenceType = 'topup';
        resultReferenceId = result.topupId;
        break;
      }
      case 'MANUAL_ADJUSTMENT': {
        await adjustWallet(
          context.db,
          {
            eventId: context.eventId,
            userId: String(payload.userId),
            amountPoints: Number(payload.amountPoints),
            reason: request.reason,
            createdBy: request.requestedBy,
            preApproved: true,
          },
          `approval-${approvalId}`,
          context.audit,
        );
        resultReferenceType = 'adjustment';
        break;
      }
      case 'LARGE_REFUND': {
        const { refund } = await refundPurchase(
          context.db,
          {
            eventId: context.eventId,
            purchaseId: String(payload.purchaseId),
            lines: payload.lines as { purchaseItemId: string; quantity: number }[] | undefined,
            reason: request.reason,
            restockInventory: Boolean(payload.restockInventory),
            requestedBy: request.requestedBy,
            preApproved: true,
          },
          idempotencyKey,
          context.audit,
        );
        resultReferenceType = 'refund';
        resultReferenceId = refund.refundId;
        break;
      }
      default:
        throw new ConflictError('This approval type cannot be executed automatically.');
    }

    await context.db
      .update(approvalRequests)
      .set({
        status: 'APPROVED',
        decidedBy: context.actor.userId,
        decidedAt: new Date(),
        decisionNote: body.note ?? null,
        resultReferenceType,
        resultReferenceId,
      })
      .where(eq(approvalRequests.id, approvalId));

    await recordAudit(context.db, {
      ...context.audit,
      action: 'approval.approved',
      targetType: 'approval_request',
      targetId: approvalId,
      after: { decision: 'APPROVED', resultReferenceType, resultReferenceId },
    });

    return ok({ id: approvalId, status: 'APPROVED', resultReferenceType, resultReferenceId });
  },
);
