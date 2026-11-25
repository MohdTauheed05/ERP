import React, { useEffect, useState } from 'react';
import { Download, Link2, Paperclip, History, Upload, X } from 'lucide-react';
import { apiRequest, apiUrl, downloadProtectedFile, getAuthToken } from '../services/api';

interface DocumentPanelProps {
  docType: string;
  docId: number;
  docNumber: string;
  onClose: () => void;
}

export function DocumentPanel({ docType, docId, docNumber, onClose }: DocumentPanelProps) {
  const [links, setLinks] = useState<{ docType: string; id: number; docNumber: string; status: string; relation: string }[]>([]);
  const [audit, setAudit] = useState<{ id: number; username: string; action: string; created_at: string }[]>([]);
  const [attachments, setAttachments] = useState<{ id: number; file_name: string; size_bytes: number; uploaded_by_name: string; created_at: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const [linkRes, attRes] = await Promise.all([
        apiRequest<{ links: typeof links; audit: typeof audit }>(`/api/system/links/${docType}/${docId}`),
        apiRequest<{ items: typeof attachments }>(`/api/system/attachments?doc_type=${encodeURIComponent(docType)}&doc_id=${docId}`),
      ]);
      setLinks(linkRes.links);
      setAudit(linkRes.audit);
      setAttachments(attRes.items);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load document details');
    }
  };

  useEffect(() => {
    void load();
  }, [docType, docId]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('doc_type', docType);
      fd.append('doc_id', String(docId));
      const token = getAuthToken();
      const res = await fetch(apiUrl('/api/system/attachments/upload'), {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      if (!res.ok) {
        const d = (await res.json()) as { error?: string };
        throw new Error(d.error || 'Upload failed');
      }
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="fixed inset-y-0 right-0 w-full max-w-md bg-white border-l border-slate-200 shadow-xl z-50 flex flex-col">
      <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
        <div>
          <p className="text-xs text-slate-500">{docType}</p>
          <h3 className="text-base font-semibold text-slate-900 font-mono tabular-nums">{docNumber}</h3>
        </div>
        <button type="button" onClick={onClose} className="p-1.5 text-slate-500 hover:text-slate-900 rounded-md hover:bg-slate-100">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-5 space-y-6">
        {error && <div className="p-3 bg-red-50 border border-red-200 rounded text-xs text-red-700">{error}</div>}

        <section>
          <h4 className="text-xs font-semibold text-slate-900 flex items-center gap-1.5 mb-3">
            <Link2 className="w-3.5 h-3.5 text-slate-500" />
            Linked Documents
          </h4>
          {links.length === 0 ? (
            <p className="text-xs text-slate-500">No downstream linked transactions yet.</p>
          ) : (
            <div className="divide-y divide-slate-100 border border-slate-200 rounded-md">
              {links.map((l, idx) => (
                <div key={idx} className="px-3 py-2 flex items-center justify-between text-xs">
                  <div>
                    <span className="font-mono font-medium text-slate-900">{l.docNumber}</span>
                    <span className="text-slate-400 mx-1.5">·</span>
                    <span className="text-slate-600">{l.relation}</span>
                  </div>
                  <span className="text-slate-600">{l.status}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section>
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-xs font-semibold text-slate-900 flex items-center gap-1.5">
              <Paperclip className="w-3.5 h-3.5 text-slate-500" />
              Attachments ({attachments.length})
            </h4>
            <label className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-white bg-slate-900 rounded cursor-pointer hover:bg-slate-800">
              <Upload className="w-3 h-3" />
              {uploading ? 'Uploading...' : 'Attach File'}
              <input type="file" className="hidden" onChange={handleUpload} disabled={uploading} />
            </label>
          </div>
          {attachments.length === 0 ? (
            <p className="text-xs text-slate-500">No files attached. Supports PDF, Excel, Word, and images.</p>
          ) : (
            <div className="divide-y divide-slate-100 border border-slate-200 rounded-md">
              {attachments.map((a) => (
                <div key={a.id} className="px-3 py-2 flex items-center justify-between text-xs">
                  <div className="min-w-0 pr-2">
                    <p className="font-medium text-slate-800 truncate">{a.file_name}</p>
                    <p className="text-[11px] text-slate-500 tabular-nums">
                      {(a.size_bytes / 1024).toFixed(1)} KB · {a.uploaded_by_name || 'User'}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => downloadProtectedFile(`/api/system/attachments/${a.id}/download`, a.file_name)}
                    className="p-1.5 text-slate-600 hover:text-slate-900 rounded hover:bg-slate-100"
                  >
                    <Download className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section>
          <h4 className="text-xs font-semibold text-slate-900 flex items-center gap-1.5 mb-3">
            <History className="w-3.5 h-3.5 text-slate-500" />
            Document Timeline & Audit Trail
          </h4>
          {audit.length === 0 ? (
            <p className="text-xs text-slate-500">No audit history logged.</p>
          ) : (
            <div className="space-y-2.5">
              {audit.map((a) => (
                <div key={a.id} className="text-xs border-b border-slate-100 pb-2">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-slate-900">{a.action}</span>
                    <span className="text-[11px] text-slate-500 font-mono tabular-nums">{a.created_at.slice(0, 16).replace('T', ' ')}</span>
                  </div>
                  <p className="text-[11px] text-slate-500">By {a.username}</p>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
