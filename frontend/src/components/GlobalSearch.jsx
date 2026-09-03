import { useState, useEffect, useRef, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { Input } from "./ui/input";
import { Search, Loader2, AlertTriangle } from "lucide-react";
import { CritBadge } from "./shared";

function Highlight({ text, q }) {
  if (!q || !text) return <span>{text}</span>;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return <span>{text}</span>;
  return (
    <span>
      {text.slice(0, idx)}
      <mark className="bg-orange-200 text-inherit rounded-sm px-0">{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </span>
  );
}

export function GlobalSearch() {
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const boxRef = useRef(null);
  const timer = useRef(null);

  const flat = useMemo(() => (data?.groups || []).flatMap((g) => g.items), [data]);

  const runSearch = async (query) => {
    setLoading(true); setError(false);
    try {
      const { data: d } = await api.get(`/search?q=${encodeURIComponent(query)}`);
      setData(d); setActive(-1);
    } catch { setError(true); setData(null); }
    finally { setLoading(false); }
  };

  useEffect(() => {
    clearTimeout(timer.current);
    if (q.trim().length < 2) { setData(null); setError(false); setLoading(false); return; }
    setLoading(true);
    timer.current = setTimeout(() => runSearch(q.trim()), 300);
    return () => clearTimeout(timer.current);
  }, [q]);

  useEffect(() => {
    const onClick = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const go = (item) => { setOpen(false); setQ(""); setData(null); nav(item.link); };

  const onKeyDown = (e) => {
    if (e.key === "Escape") { setOpen(false); return; }
    if (!flat.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, flat.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); if (active >= 0) go(flat[active]); else if (flat.length) go(flat[0]); }
  };

  const showPanel = open && q.trim().length >= 2;
  let idx = -1;

  return (
    <div className="relative flex-1 max-w-md" ref={boxRef}>
      <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground z-10" />
      {loading && <Loader2 size={14} className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-[var(--orange)] z-10" />}
      <Input data-testid="global-search" value={q} role="combobox" aria-expanded={showPanel} aria-controls="global-search-results" aria-activedescendant={active >= 0 ? `global-search-option-${active}` : undefined} aria-autocomplete="list" aria-label="Search across test cases, municipalities, findings, evidence, projects, properties, regression suites and demos"
        onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onKeyDown={onKeyDown}
        placeholder="Search test cases, municipalities, findings…" className="pl-9 h-9 bg-[var(--paper)]" autoComplete="off" />
      {showPanel && (
        <div id="global-search-results" className="fixed left-3 right-3 top-14 z-50 w-auto max-h-[70vh] overflow-y-auto bg-card border rounded-xl shadow-xl sm:absolute sm:left-0 sm:right-auto sm:top-auto sm:mt-1 sm:w-[min(480px,calc(100vw-1.5rem))]" data-testid="search-results-panel" role="listbox" aria-label="Search results" aria-busy={loading}>
          {error && (
            <div className="p-4 text-sm text-red-700 flex items-center gap-2" data-testid="search-error">
              <AlertTriangle size={15} /> Search failed.
              <button className="ml-auto text-xs font-semibold text-[var(--navy)] underline" onClick={() => runSearch(q.trim())} data-testid="search-retry">Retry</button>
            </div>
          )}
           {!error && loading && (
             <div className="p-4 text-sm text-muted-foreground flex items-center gap-2" role="status" data-testid="search-loading">
               <Loader2 size={15} className="animate-spin text-[var(--orange)]" /> Searching for “{q.trim()}”…
             </div>
           )}
          {!error && !loading && data && data.total === 0 && (
            <div className="p-4 text-sm text-muted-foreground" data-testid="search-no-results">No results found for “{q.trim()}”.</div>
          )}
          {!error && data && (data.groups || []).map((g) => (
            <div key={g.label}>
              <div className="px-3 pt-2.5 pb-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground bg-[var(--paper)]/60">{g.label}</div>
              {g.items.map((item) => {
                idx += 1; const i = idx;
                return (
                  <button id={`global-search-option-${i}`} key={item.id} type="button" role="option" aria-selected={active === i} data-testid="search-result-item"
                    onClick={() => go(item)} onMouseEnter={() => setActive(i)}
                    className={`w-full text-left px-3 py-2 flex items-center gap-2.5 border-b last:border-0 ${active === i ? "bg-orange-50" : "hover:bg-[var(--paper)]"}`}>
                    <span className="text-[9px] font-bold uppercase text-white bg-[var(--navy)] rounded px-1.5 py-0.5 shrink-0">{item.type}</span>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-[var(--navy)] truncate"><Highlight text={item.name} q={q.trim()} /></span>
                      {item.context && <span className="block text-xs text-muted-foreground truncate"><Highlight text={item.context} q={q.trim()} /></span>}
                    </span>
                    <span className="ml-auto flex items-center gap-1.5 shrink-0">
                      {item.criticality != null && <CritBadge value={item.criticality} />}
                      {item.status && <span className="text-[10px] text-muted-foreground border rounded-full px-1.5 py-0.5">{item.status}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
          <div className="sr-only" aria-live="polite">{data ? `${data.total} results` : ""}</div>
        </div>
      )}
    </div>
  );
}
