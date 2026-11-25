import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { apiRequest, apiUrl } from '../services/api';
import type { CompanyProfile } from '../types/erp';

interface CompanyContextValue {
  company: CompanyProfile;
  logoUrl: string;
  logoVersion: number;
  needsSetup: boolean;
  bootLoaded: boolean;
  setNeedsSetup: (val: boolean) => void;
  refreshCompany: () => Promise<void>;
}

const DEFAULT_COMPANY: CompanyProfile = {
  name: 'Enterprise ERP',
  short_name: 'ERP',
  logo_path: '',
  logo_url: '',
  address: '',
  po_box: '',
  country: 'UNITED ARAB EMIRATES',
  trn: '',
  telephone: '',
  email: '',
  website: '',
  currency: 'AED',
  vat_rate: 5,
  vat_enabled: 1,
};

const CompanyContext = createContext<CompanyContextValue>({
  company: DEFAULT_COMPANY,
  logoUrl: '',
  logoVersion: 0,
  needsSetup: false,
  bootLoaded: false,
  setNeedsSetup: () => {},
  refreshCompany: async () => {},
});

export function CompanyProvider({ children }: { children: React.ReactNode }) {
  const [company, setCompany] = useState<CompanyProfile>(DEFAULT_COMPANY);
  const [logoVersion, setLogoVersion] = useState(0);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [bootLoaded, setBootLoaded] = useState(false);

  const refreshCompany = useCallback(async () => {
    try {
      const res = await apiRequest<{ needsSetup: boolean; company: CompanyProfile | null }>('/api/auth/status');
      setNeedsSetup(res.needsSetup);
      if (res.company) {
        setCompany(res.company);
        if (res.company.name) {
          document.title = res.company.short_name ? `${res.company.short_name} — ${res.company.name}` : res.company.name;
        }
      }
      setLogoVersion((v) => v + 1);
    } catch {
      // ignore transient boot error
    } finally {
      setBootLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refreshCompany();
  }, [refreshCompany]);

  const logoUrl = company.logo_path ? apiUrl(`/api/auth/logo?v=${encodeURIComponent(company.logo_path)}&r=${logoVersion}`) : '';

  return (
    <CompanyContext.Provider value={{ company, logoUrl, logoVersion, needsSetup, bootLoaded, setNeedsSetup, refreshCompany }}>
      {children}
    </CompanyContext.Provider>
  );
}

export function useCompany(): CompanyContextValue {
  return useContext(CompanyContext);
}
