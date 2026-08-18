"use client";
import { createContext, useContext, useEffect, useState, useCallback } from "react";
import type { User, Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";

export type Profile = {
  user_id: string;
  customer_type: "private" | "business";
  first_name: string;
  last_name: string;
  phone: string | null;
  newsletter_opt_in: boolean;
  terms_accepted_at: string | null;
  privacy_accepted_at: string | null;
  created_at: string;
  updated_at: string;
};

export type BusinessProfile = {
  user_id: string;
  company_name: string;
  legal_form: string | null;
  tax_number: string;
  vat_id: string | null;
  website: string | null;
  authority_confirmed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type AddressRow = {
  id: string;
  user_id: string;
  first_name: string;
  last_name: string;
  company: string | null;
  street: string;
  house_number: string;
  zip: string;
  city: string;
  country: string;
  is_default_shipping: boolean;
  is_default_billing: boolean;
  created_at: string;
  updated_at: string;
};

type AuthCtx = {
  user: User | null;
  session: Session | null;
  profile: Profile | null;
  businessProfile: BusinessProfile | null;
  addresses: AddressRow[];
  loading: boolean;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  refreshAddresses: () => Promise<void>;
};

const AuthContext = createContext<AuthCtx>({
  user: null,
  session: null,
  profile: null,
  businessProfile: null,
  addresses: [],
  loading: true,
  signOut: async () => {},
  refreshProfile: async () => {},
  refreshAddresses: async () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [businessProfile, setBusinessProfile] = useState<BusinessProfile | null>(null);
  const [addresses, setAddresses] = useState<AddressRow[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchProfile = useCallback(async (uid: string) => {
    if (!supabase) return;
    const { data } = await supabase
      .from("profiles")
      .select("*")
      .eq("user_id", uid)
      .single();
    setProfile(data as Profile | null);

    if (data?.customer_type === "business") {
      const { data: bp } = await supabase
        .from("business_profiles")
        .select("*")
        .eq("user_id", uid)
        .single();
      setBusinessProfile(bp as BusinessProfile | null);
    } else {
      setBusinessProfile(null);
    }
  }, []);

  const fetchAddresses = useCallback(async (uid: string) => {
    if (!supabase) return;
    const { data } = await supabase
      .from("addresses")
      .select("*")
      .eq("user_id", uid)
      .order("created_at", { ascending: true });
    setAddresses((data as AddressRow[] | null) ?? []);
  }, []);

  const refreshProfile = useCallback(async () => {
    if (user) await fetchProfile(user.id);
  }, [user, fetchProfile]);

  const refreshAddresses = useCallback(async () => {
    if (user) await fetchAddresses(user.id);
  }, [user, fetchAddresses]);

  useEffect(() => {
    if (!supabase) {
      setLoading(false);
      return;
    }

    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s);
      setUser(s?.user ?? null);
      if (s?.user) {
        Promise.all([fetchProfile(s.user.id), fetchAddresses(s.user.id)]).then(() => setLoading(false));
      } else {
        setLoading(false);
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      setUser(s?.user ?? null);
      if (s?.user) {
        fetchProfile(s.user.id);
        fetchAddresses(s.user.id);
      } else {
        setProfile(null);
        setBusinessProfile(null);
        setAddresses([]);
      }
    });

    return () => subscription.unsubscribe();
  }, [fetchProfile, fetchAddresses]);

  const signOut = useCallback(async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
    setUser(null);
    setSession(null);
    setProfile(null);
    setBusinessProfile(null);
    setAddresses([]);
  }, []);

  return (
    <AuthContext.Provider value={{ user, session, profile, businessProfile, addresses, loading, signOut, refreshProfile, refreshAddresses }}>
      {children}
    </AuthContext.Provider>
  );
}
