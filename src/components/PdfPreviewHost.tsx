import React, { useEffect, useRef, useState } from 'react';
import { Download, FileText, Printer, X } from 'lucide-react';
import { registerPdfPreviewHandler, type PdfPreviewPayload } from '../utils/export';

export function PdfPreviewHost() {
  const [preview, setPreview] = useState<PdfPreviewPayload | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    registerPdfPreviewHandler((payload) => {
      setPreview((prev) => {
        if (prev?.blobUrl) URL.revokeObjectURL(prev.blobUrl);
        return payload;
      });
    });
    return () => {
      registerPdfPreviewHandler(null);
    };
  }, []);

  const closePreview = () => {
    setPreview((prev) => {
      if (prev?.blobUrl) URL.revokeObjectURL(prev.blobUrl);
      return null;
    });
  };

  const handlePrint = () => {
    try {
      iframeRef.current?.contentWindow?.focus();
      iframeRef.current?.contentWindow?.print();
    } catch {
      window.print();
    }
  };

  if (!preview) return null;

  return (
    <div className="fixed inset-0 bg-slate-900/60 z-[70] flex items-center justify-center p-4 no-print">
      <div className="bg-white border border-slate-200 rounded-lg w-full max-w-5xl h-[90vh] flex flex-col overflow-hidden shadow-xl">
        <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <FileText className="w-4 h-4 text-slate-700 shrink-0" />
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-slate-900 truncate">Print Preview — {preview.title}</h3>
              <p className="text-[11px] text-slate-500 font-mono truncate">{preview.filename}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handlePrint}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-100 whitespace-nowrap"
            >
              <Printer className="w-3.5 h-3.5" /> Print
            </button>
            <button
              type="button"
              onClick={() => preview.save()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" /> Download PDF
            </button>
            <button
              type="button"
              onClick={closePreview}
              className="p-1.5 text-slate-500 hover:text-slate-900 rounded-md hover:bg-slate-200"
              title="Close Print Preview"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 bg-slate-200 relative">
          <iframe
            ref={iframeRef}
            src={`${preview.blobUrl}#toolbar=1&navpanes=0`}
            title={`Print Preview: ${preview.title}`}
            className="w-full h-full border-0 bg-white"
          />
        </div>

        <div className="px-4 py-2 border-t border-slate-200 bg-slate-50 flex items-center justify-between text-[11px] text-slate-500">
          <span>Review the document layout, company logo, TRN, line items, and totals above before downloading or printing.</span>
          <a
            href={preview.blobUrl}
            download={preview.filename}
            className="font-medium text-slate-800 underline hover:text-slate-900"
          >
            Direct Save ({preview.filename})
          </a>
        </div>
      </div>
    </div>
  );
}
