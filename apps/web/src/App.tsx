import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Direction } from 'radix-ui';
import { useEffect, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { Toaster } from 'sonner';
import { AppShell } from './components/shell/AppShell';
import { ApprovalDialog } from './components/ui/feedback';
import { ControllersPage } from './features/controllers/ControllersPage';
import { DisplayPage } from './features/display/DisplayPage';
import { FloorPage } from './features/floor/FloorPage';
import { LoginPage } from './features/auth/LoginPage';
import { ReportsPage } from './features/reports/ReportsPage';
import { ReservationsPage } from './features/reservations/ReservationsPage';
import { SettingsPage } from './features/settings/SettingsPage';
import { StockPage } from './features/stock/StockPage';
import { applyDocumentPrefs, usePrefs } from './i18n';
import { ApiError } from './lib/api';
import { can, useAuth } from './lib/auth';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 2_000,
      retry: (count, err) => {
        if (err instanceof ApiError && err.status >= 400 && err.status < 500) return false;
        return count < 3;
      },
    },
  },
});

function RequireAuth({ children, allow }: { children: ReactNode; allow?: (role?: import('./lib/auth').Role) => boolean }) {
  const user = useAuth((s) => s.user);
  if (!user) return <Navigate to="/login" replace />;
  if (allow && !allow(user.role)) return <Navigate to="/floor" replace />;
  return <>{children}</>;
}

export function App() {
  const lang = usePrefs((s) => s.lang);
  const theme = usePrefs((s) => s.theme);
  useEffect(() => applyDocumentPrefs(lang, theme), [lang, theme]);

  return (
    <QueryClientProvider client={queryClient}>
      <Direction.Provider dir={lang === 'ar' ? 'rtl' : 'ltr'}>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
              path="/display/:stationId"
              element={
                <RequireAuth>
                  <DisplayPage />
                </RequireAuth>
              }
            />
            <Route
              element={
                <RequireAuth>
                  <AppShell />
                </RequireAuth>
              }
            >
              <Route index element={<Navigate to="/floor" replace />} />
              <Route path="/floor" element={<FloorPage />} />
              <Route path="/controllers" element={<ControllersPage />} />
              <Route
                path="/reservations"
                element={
                  <RequireAuth allow={can.reservations}>
                    <ReservationsPage />
                  </RequireAuth>
                }
              />
              <Route
                path="/reports"
                element={
                  <RequireAuth allow={can.reports}>
                    <ReportsPage />
                  </RequireAuth>
                }
              />
              <Route
                path="/stock"
                element={
                  <RequireAuth allow={can.reports}>
                    <StockPage />
                  </RequireAuth>
                }
              />
              <Route
                path="/settings/*"
                element={
                  <RequireAuth allow={can.settings}>
                    <SettingsPage />
                  </RequireAuth>
                }
              />
            </Route>
            <Route path="*" element={<Navigate to="/floor" replace />} />
          </Routes>
        </BrowserRouter>
        <Toaster
          // Inline-start: the device sheet docks at inline-end, toasts must never cover its buttons.
          position={lang === 'ar' ? 'bottom-right' : 'bottom-left'}
          dir={lang === 'ar' ? 'rtl' : 'ltr'}
          theme={theme}
          richColors
          closeButton
          toastOptions={{ style: { fontFamily: 'var(--font-sans)' } }}
        />
        <ApprovalDialog />
      </Direction.Provider>
    </QueryClientProvider>
  );
}
