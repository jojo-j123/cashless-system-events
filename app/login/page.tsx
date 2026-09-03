import { LoginForm } from './LoginForm';

export const metadata = { title: 'Sign in · Cashless Event Platform' };

export default function LoginPage(): React.ReactElement {
  return (
    <main className="flex min-h-screen items-center justify-center bg-ink-900 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold text-white">Cashless Event Platform</h1>
          <p className="mt-1 text-sm text-ink-400">Sign in to continue</p>
        </div>
        <LoginForm />
      </div>
    </main>
  );
}
