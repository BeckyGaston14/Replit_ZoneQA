import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { LogOut, ShieldCheck, ChevronRight, Menu, X } from "lucide-react";
import { GlobalSearch } from "./GlobalSearch";
import { useEffect, useMemo, useState } from "react";
import {
  activeSectionId,
  defaultExpanded,
  preferenceKey,
  readExpandedPreferences,
  sectionId,
  setAllSections,
  toggleSection,
  visibleSectionItems,
  writeExpandedPreferences,
  navItemMatches,
} from "../lib/sidebarState";
import { userRoleLabel } from "../lib/userValidation";
import { useFocusTrap } from "../lib/useFocusTrap";
import { NAV_SECTIONS as CONFIGURED_SECTIONS } from "../lib/navigationConfig";

export const SECTIONS = CONFIGURED_SECTIONS;

const RESOLVED_SECTIONS = SECTIONS.map((section) => ({ ...section, id: section.id || sectionId(section.label) }));

export default function Layout({ children }) {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const location = useLocation();
  const visibleSections = useMemo(() => RESOLVED_SECTIONS.map((section) => ({
    ...section,
    items: visibleSectionItems(section, user),
  })), [user]);
  const sectionIds = useMemo(() => visibleSections.map((section) => section.id), [visibleSections]);
  const sectionIdsKey = sectionIds.join("|");
  const storageKey = preferenceKey(user?.id);
   const activeId = activeSectionId(visibleSections, location);
  const [expandedGroups, setExpandedGroups] = useState(() => defaultExpanded(sectionIds));
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [mobileViewport, setMobileViewport] = useState(() => window.innerWidth < 1024);
  const closeMobileMenu = () => setMobileOpen(false);
  const mobileNavRef = useFocusTrap(mobileOpen, closeMobileMenu);

  useEffect(() => {
    setExpandedGroups(readExpandedPreferences(window.localStorage, storageKey, sectionIdsKey.split("|")));
    setPreferencesReady(true);
  }, [storageKey, sectionIdsKey]); // IDs are stable; this avoids object-identity reloads.

  useEffect(() => {
    if (preferencesReady) writeExpandedPreferences(window.localStorage, storageKey, expandedGroups);
  }, [expandedGroups, preferencesReady, storageKey]);

  useEffect(() => {
    if (activeId && expandedGroups[activeId] === false) {
      setExpandedGroups((current) => ({ ...current, [activeId]: true }));
    }
  }, [activeId, expandedGroups]);
  useEffect(() => { closeMobileMenu(); }, [location.pathname, location.search]);
  useEffect(() => {
    const updateViewport = () => setMobileViewport(window.innerWidth < 1024);
    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, []);
  const setGroupExpanded = (id) => {
    setExpandedGroups((current) => toggleSection(current, id, activeId));
  };
  const setAllExpanded = (isExpanded) => {
    setExpandedGroups((current) => setAllSections(current, sectionIds, isExpanded, activeId));
  };

  return (
    <div className="min-h-screen flex bg-[var(--paper)]">
      {mobileOpen && <button type="button" className="fixed inset-0 z-30 bg-black/40 lg:hidden" onClick={closeMobileMenu} aria-label="Close navigation menu" />}
      <aside ref={mobileNavRef} id="primary-navigation" aria-label="Primary navigation"
        aria-hidden={mobileViewport && !mobileOpen ? true : undefined} inert={mobileViewport && !mobileOpen ? true : undefined}
        className={`w-[min(16rem,calc(100vw-1rem))] shrink-0 brand-gradient text-white flex flex-col fixed h-screen z-40 transition-transform duration-200 lg:translate-x-0 ${mobileOpen ? "translate-x-0" : "-translate-x-full"}`}>
         <div className="px-5 py-5 flex items-center gap-2 border-b border-white/10">
          <div className="accent-gradient h-9 w-9 rounded-lg flex items-center justify-center font-bold font-display shrink-0">Z</div>
          <div>
            <div className="font-display font-bold text-[15px] leading-none">ZoneQA</div>
            <div className="text-[10px] text-white/60 tracking-wide mt-0.5">BASSETT TESTING</div>
          </div>
            <button type="button" className="ml-auto lg:hidden rounded p-1 hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white" onClick={closeMobileMenu} aria-label="Close navigation"><X size={18} /></button>
        </div>
        <nav className="flex-1 overflow-y-auto py-3 px-2">
          <div className="flex items-center justify-between px-3 mb-2 text-[10px]">
            <span className="font-bold tracking-[0.12em] uppercase text-white/40">Navigation</span>
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => setAllExpanded(true)} aria-label="Expand all navigation sections"
                className="rounded px-1.5 py-1 text-white/50 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
                data-testid="expand-all-nav">Expand all</button>
              <span className="text-white/20" aria-hidden="true">·</span>
              <button type="button" onClick={() => setAllExpanded(false)} aria-label="Collapse all navigation sections"
                className="rounded px-1.5 py-1 text-white/50 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
                data-testid="collapse-all-nav">Collapse all</button>
            </div>
          </div>
          {visibleSections.map((sec) => {
            const expanded = expandedGroups[sec.id] !== false || activeId === sec.id;
            const contentId = `nav-section-${sec.id}`;
            return <div key={sec.label} className="mb-3">
              <button type="button" onClick={() => setGroupExpanded(sec.id)} aria-controls={contentId}
                aria-expanded={expanded} aria-label={`${expanded ? "Collapse" : "Expand"} ${sec.label} navigation section`}
                className="w-full flex items-center gap-2 px-3 pb-1.5 text-left text-[10px] font-bold tracking-[0.12em] uppercase text-white/40 hover:text-white/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 rounded"
                data-testid={`nav-section-toggle-${sec.id}`}>
                <ChevronRight size={13} aria-hidden="true" className={`shrink-0 transition-transform duration-150 ${expanded ? "rotate-90" : ""}`} />
                <span className="flex-1">{sec.label}</span>
              </button>
              <div id={contentId} role="region" aria-label={`${sec.label} navigation`}
                aria-hidden={!expanded} inert={!expanded ? true : undefined}
                className={`grid transition-[grid-template-rows,opacity] duration-150 ease-out ${expanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0 pointer-events-none"}`}>
                <div className="min-h-0 overflow-hidden">
                {sec.description && <p className="px-3 pb-2 text-[11px] leading-snug text-white/45">{sec.description}</p>}
                <div className="space-y-0.5">
                {sec.items.map((n) => {
                  const isActive = navItemMatches(n, location);
                  return (
                      <Link key={n.to} to={n.to} onClick={closeMobileMenu} data-testid={n.testId || `nav-${n.label.toLowerCase().replace(/[^a-z]+/g, "-")}`}
                       aria-current={isActive ? "page" : undefined}
                       className={`flex items-center gap-3 px-3 py-2 rounded-lg text-[13px] font-medium transition-colors ${
                         isActive ? "bg-white/15 text-white" : "text-white/70 hover:bg-white/10 hover:text-white"
                       }`}>
                      <n.icon size={17} className="shrink-0" />
                      <span className="flex-1 truncate">{n.label}</span>
                     </Link>
                  );
                })}
              </div>
              </div>
            </div>
            </div>;
          })}
        </nav>
        <div className="p-3 border-t border-white/10">
          <div className="flex items-center gap-2 mb-2">
            <div className="h-8 w-8 rounded-full accent-gradient flex items-center justify-center text-xs font-bold">
              {user?.name?.[0] || "U"}
            </div>
            <div className="min-w-0">
              <div className="text-xs font-semibold truncate">{user?.name}</div>
              <div className="text-[10px] text-white/60 flex items-center gap-1"><ShieldCheck size={10} />{userRoleLabel(user?.role)}</div>
            </div>
          </div>
          <Link to="/security" onClick={closeMobileMenu}
            className="mb-2 w-full flex items-center justify-center gap-2 text-xs text-white/80 hover:text-white hover:bg-white/10 rounded-lg py-2">
            Security & password
          </Link>
          <button data-testid="logout-btn" onClick={() => { logout(); nav("/login"); }}
            className="w-full flex items-center justify-center gap-2 text-xs bg-white/10 hover:bg-white/20 rounded-lg py-2 transition-colors">
            <LogOut size={14} /> Sign out
          </button>
        </div>
      </aside>

      <div className="flex-1 lg:ml-64 flex flex-col min-h-screen min-w-0">
        <header className="h-14 bg-card/80 backdrop-blur border-b flex items-center px-3 sm:px-6 gap-3 sticky top-0 z-20">
          <button type="button" className="lg:hidden rounded p-2 hover:bg-muted focus-visible:ring-2 focus-visible:ring-[var(--orange)]" onClick={() => setMobileOpen(true)} aria-label="Open navigation" aria-controls="primary-navigation" aria-expanded={mobileOpen}><Menu size={20} /></button>
          <GlobalSearch />
          <div className="ml-auto text-xs text-muted-foreground hidden lg:block">Internal QA Platform · Zoneomics</div>
        </header>
        <main className="flex-1 p-3 sm:p-6 max-w-[1500px] w-full">{children}</main>
      </div>
    </div>
  );
}
