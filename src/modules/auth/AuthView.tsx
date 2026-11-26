Attempting to perform the InitializeDefaultDrives operation on the 'FileSystem' provider failed.
import React, { useState } from 'react';
import { ShieldCheck, Lock, UserPlus } from 'lucide-react';
import { apiRequest, setAuthToken } from '../../services/api';
import { useCompany } from '../../context/CompanyContext';
import type { RolePermission, User } from '../../types/erp';

interface AuthViewProps {
  needsSetup: boolean;
  companyName?: string;
  onAuthenticated: (user: User, permissions: RolePermission[]) => void;
}

export function AuthView({ needsSetup, companyName, onAuthenticated }: AuthViewProps) {
  const { company, logoUrl } = useCompany();
  const [mode, setMode] = useState<'setup' | 'login'>(needsSetup ? 'setup' : 'login');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (mode === 'setup') {
        const res = await apiRequest<{ token: string; user: User }>('/api/auth/setup-admin', {
          method: 'POST',
          body: JSON.stringify({ username, email, fullName, password }),
        });
        setAuthToken(res.token);
        const me = await apiRequest<{ user: User; permissions: RolePermission[] }>('/api/auth/me');
        onAuthenticated(me.user, me.permissions);
      } else {
        const res = await apiRequest<{ token: string; user: User; permissions: RolePermission[] }>('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ username, password }),
        });
        setAuthToken(res.token);
        onAuthenticated(res.user, res.permissions);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-100 flex items-center justify-center p-6">
      <div className="w-full max-w-4xl bg-white border border-slate-200 rounded-lg overflow-hidden grid grid-cols-1 md:grid-cols-12">
        <div className="md:col-span-5 bg-slate-900 text-white p-8 flex flex-col justify-between">
          <div>
            {logoUrl && (
              <div className="mb-5 bg-white rounded-md p-2 inline-flex items-center justify-center">
                <img src={logoUrl} alt={company.name} className="h-10 w-auto max-w-[160px] object-contain" />
              </div>
            )}
            <div className="flex items-center gap-2 text-slate-300 text-xs font-medium mb-4">
              <ShieldCheck className="w-4 h-4 text-sky-400" />
              <span>Enterprise Resource Planning</span>
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-white">
              {companyName || company.name || 'Enterprise ERP'}
            </h1>
            <p className="mt-3 text-sm text-slate-300 leading-relaxed">
              Integrated lubricant manufacturing, blending, filling, procurement, perpetual inventory, quality laboratory, and double-entry accounting.
            </p>
          </div>
          <div className="pt-8 border-t border-slate-800 space-y-2 text-xs text-slate-400">
            <p>Secure ERP database · Role-based access control</p>
            <p>Double-Entry GL · UAE 5% VAT · Batch Genealogy</p>
          </div>
        </div>

        <div className="md:col-span-7 p-8">
          <div className="mb-6">
            <h2 className="text-xl font-semibold text-slate-900 flex items-center gap-2">
              {mode === 'setup' ? <UserPlus className="w-5 h-5 text-slate-700" /> : <Lock className="w-5 h-5 text-slate-700" />}
              {mode === 'setup' ? 'Initial Super Admin Setup' : 'Sign In to Workspace'}
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              {mode === 'setup'
                ? 'Create the first Super Administrator account to initialize your local ERP database.'
                : 'Enter your username or email and password to access your authorized modules.'}
            </p>
          </div>

          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-xs text-red-700">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === 'setup' && (
              <>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Full Name</label>
                  <input
                    type="text"
                    required
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="e.g. Tariq Al Mansoori"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-900"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Work Email</label>
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="admin@company.com"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-900"
                  />
                </div>
              </>
            )}

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {mode === 'setup' ? 'Administrator Username' : 'Username or Email'}
              </label>
              <input
                type="text"
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={mode === 'setup' ? 'admin' : 'admin or email'}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-900"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Password</label>
              <input
                type="password"
                required
                minLength={mode === 'setup' ? 8 : 1}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === 'setup' ? 'Minimum 8 characters' : 'Enter password'}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-900"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 px-4 bg-slate-900 text-white text-sm font-medium rounded-md hover:bg-slate-800 disabled:opacity-50 transition-colors"
            >
              {loading
                ? 'Authenticating...'
                : mode === 'setup'
                ? 'Initialize ERP & Sign In'
                : 'Sign In'}
            </button>
          </form>

          {!needsSetup && mode === 'setup' && (
            <button
              type="button"
              onClick={() => setMode('login')}
              className="mt-4 text-xs text-slate-600 hover:text-slate-900 underline"
            >
              Back to Sign In
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
