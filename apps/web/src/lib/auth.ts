import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type Role = 'owner' | 'manager' | 'cashier' | 'waiter';

export interface User {
  id: string;
  orgId: string;
  branchId: string;
  role: Role;
  name: string;
}

interface AuthState {
  token: string | null;
  user: User | null;
  /** The branch this device belongs to (kept across logouts so the login screen knows whose staff to show). */
  deviceBranchId: string | null;
  /** Shop code entered once on this device (online installs); kept across logouts. */
  accessCode: string | null;
  login: (token: string, user: User) => void;
  logout: () => void;
  setDeviceBranch: (id: string) => void;
  setAccessCode: (code: string | null) => void;
}

export const useAuth = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      deviceBranchId: null,
      accessCode: null,
      login: (token, user) => set({ token, user, deviceBranchId: user.branchId }),
      logout: () => set({ token: null, user: null }),
      setDeviceBranch: (deviceBranchId) => set({ deviceBranchId }),
      setAccessCode: (accessCode) => set({ accessCode }),
    }),
    {
      name: 'lounge-auth',
      storage: createJSONStorage(() => {
        try {
          return localStorage;
        } catch {
          return sessionStorage;
        }
      }),
    },
  ),
);

const MGMT: Role[] = ['owner', 'manager'];
const DESK: Role[] = ['owner', 'manager', 'cashier'];

/** Mirrors the server's permission table — the server still enforces every rule. */
export const can = {
  manageSessions: (r?: Role) => !!r && DESK.includes(r),
  checkout: (r?: Role) => !!r && DESK.includes(r),
  reservations: (r?: Role) => !!r && DESK.includes(r),
  shift: (r?: Role) => !!r && DESK.includes(r),
  stock: (r?: Role) => !!r && DESK.includes(r),
  reports: (r?: Role) => !!r && MGMT.includes(r),
  settings: (r?: Role) => !!r && MGMT.includes(r),
  isManager: (r?: Role) => !!r && MGMT.includes(r),
};
