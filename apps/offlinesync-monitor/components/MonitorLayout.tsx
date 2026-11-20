import React, { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Cpu,
  FlaskConical,
  Layers,
  ListChecks,
  ScrollText,
} from 'lucide-react';

const NAV_ITEMS = [
  { to: '/monitor', label: 'Overview', icon: Activity, end: true },
  { to: '/monitor/devices', label: 'Devices', icon: Cpu, end: false },
  { to: '/monitor/queue', label: 'Operation Queue', icon: ListChecks, end: false },
  { to: '/monitor/sessions', label: 'Sync Sessions', icon: Layers, end: false },
  { to: '/monitor/conflicts', label: 'Conflict Center', icon: AlertTriangle, end: false },
  { to: '/monitor/logs', label: 'Event Logs', icon: ScrollText, end: false },
  { to: '/monitor/experiments', label: 'Experiments', icon: FlaskConical, end: false },
];

export const MonitorLayout: React.FC = () => {
  const location = useLocation();
  const [streamConnected, setStreamConnected] = useState(false);

  useEffect(() => {
    const es = new EventSource('/api/monitor/events');
    es.onopen = () => setStreamConnected(true);
    es.onerror = () => setStreamConnected(false);
    return () => es.close();
  }, []);

  const currentTitle =
    NAV_ITEMS.find((item) =>
      item.end ? location.pathname === item.to : location.pathname.startsWith(item.to)
    )?.label ?? 'Overview';

  return (
    <div className="min-h-screen flex bg-[#F8FAFC] text-[#0F172A]">
      {/* Independent Developer Console Sidebar */}
      <aside className="hidden lg:flex lg:flex-col w-64 bg-[#0F172A] text-slate-200 border-r border-slate-800 shrink-0">
        <div className="h-16 px-6 flex items-center border-b border-slate-800">
          <Link
            to="/monitor"
            className="font-monitor-display text-base font-bold tracking-tight text-white whitespace-nowrap"
          >
            OfflineSync Monitor
          </Link>
        </div>

        <nav className="flex-1 px-3 py-5 space-y-1">
          {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
                  isActive
                    ? 'bg-slate-800 text-white'
                    : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800/50'
                }`
              }
            >
              <Icon className="w-4 h-4 shrink-0" />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="p-4 border-t border-slate-800 space-y-3">
          <div className="px-3 text-xs text-slate-400 flex items-center gap-2">
            <span
              className={`w-2 h-2 rounded-full shrink-0 ${
                streamConnected ? 'bg-emerald-500' : 'bg-amber-500'
              }`}
              aria-hidden="true"
            />
            <span>{streamConnected ? 'SSE Stream Connected' : 'SSE Reconnecting'}</span>
          </div>
          <Link
            to="/"
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium text-slate-300 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Open OfflineShop App</span>
          </Link>
        </div>
      </aside>

      {/* Main Workspace */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-16 bg-white border-b border-slate-200 px-6 flex items-center justify-between gap-6 sticky top-0 z-20">
          <div className="flex items-center gap-2 text-sm min-w-0">
            <span className="text-slate-400 font-medium hidden sm:inline">
              OfflineSync Monitor
            </span>
            <span className="text-slate-300 hidden sm:inline">/</span>
            <h1 className="font-monitor-display text-base font-semibold text-slate-900 truncate">
              {currentTitle}
            </h1>
          </div>

          <div className="flex items-center gap-4 shrink-0">
            <Link
              to="/"
              className="px-3.5 py-2 rounded-lg text-xs font-medium border border-slate-300 text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
            >
              Launch OfflineShop
            </Link>
          </div>
        </header>

        {/* Mobile Nav Strip */}
        <div className="lg:hidden bg-[#0F172A] px-4 py-2.5 flex items-center gap-2 overflow-x-auto">
          {NAV_ITEMS.map(({ to, label, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap shrink-0 ${
                  isActive ? 'bg-slate-700 text-white' : 'text-slate-300 hover:text-white'
                }`
              }
            >
              {label}
            </NavLink>
          ))}
        </div>

        <main className="flex-1 p-6 max-w-7xl w-full mx-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
};
