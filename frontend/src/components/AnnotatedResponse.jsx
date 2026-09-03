import { useRef, useState } from "react";
import { Highlighter, X, Flag } from "lucide-react";

// Renders response text with annotation highlights + text-selection annotate affordance.
export function AnnotatedResponse({ response, annotations, canAnnotate, onAnnotate, onDeleteAnnotation, onPromote }) {
  const textRef = useRef(null);
  const [sel, setSel] = useState(null); // {start, end, quoted, x, y}
  const text = response.response || "";
  const anns = (annotations || []).filter((a) => a.response_id === response.id).sort((a, b) => a.start - b.start);

  // Build non-overlapping segments
  const segments = [];
  let cursor = 0;
  for (const a of anns) {
    if (a.start == null || a.end == null || a.start < cursor || a.end > text.length || a.start >= a.end) continue;
    if (a.start > cursor) segments.push({ text: text.slice(cursor, a.start) });
    segments.push({ text: text.slice(a.start, a.end), ann: a });
    cursor = a.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });

  const handleMouseUp = () => {
    if (!canAnnotate) return;
    const s = window.getSelection();
    if (!s || s.isCollapsed || !textRef.current) { setSel(null); return; }
    if (!textRef.current.contains(s.anchorNode) || !textRef.current.contains(s.focusNode)) { setSel(null); return; }
    const range = s.getRangeAt(0);
    const pre = range.cloneRange();
    pre.selectNodeContents(textRef.current);
    pre.setEnd(range.startContainer, range.startOffset);
    const start = pre.toString().length;
    const quoted = s.toString();
    if (!quoted.trim()) { setSel(null); return; }
    const rect = range.getBoundingClientRect();
    setSel({ start, end: start + quoted.length, quoted, x: rect.left + rect.width / 2, y: rect.top });
  };

  return (
    <div>
      <p ref={textRef} onMouseUp={handleMouseUp} className="text-sm prose-response select-text" data-testid={`annotatable-${response.id}`}>
        {segments.map((seg, i) =>
          seg.ann ? (
            <mark key={i} title={`${seg.ann.annotation_type}: ${seg.ann.note || ""}`}
              className="rounded px-0.5 cursor-help"
              style={{ background: "#fde68a", borderBottom: "2px solid #f47b20" }}
              data-testid="annotation-highlight">{seg.text}</mark>
          ) : (
            <span key={i}>{seg.text}</span>
          )
        )}
      </p>

      {sel && (
        <button
          data-testid="annotate-selection-btn"
          className="fixed z-50 flex items-center gap-1.5 bg-[var(--navy)] text-white text-xs font-semibold rounded-full px-3 py-1.5 shadow-lg hover:bg-[var(--orange)] transition-colors"
          style={{ left: Math.max(8, sel.x - 50), top: Math.max(8, sel.y - 38) }}
          onMouseDown={(e) => { e.preventDefault(); onAnnotate({ start: sel.start, end: sel.end, quoted_text: sel.quoted, response_id: response.id, model: response.model }); setSel(null); window.getSelection()?.removeAllRanges(); }}>
          <Highlighter size={12} /> Annotate
        </button>
      )}

      {anns.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {anns.map((a) => (
            <div key={a.id} className="flex items-start gap-2 text-xs bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5" data-testid="annotation-item">
              <div className="flex-1 min-w-0">
                <span className="font-bold text-amber-800">{a.annotation_type}</span>
                <span className="text-muted-foreground"> — “{(a.quoted_text || "").slice(0, 80)}{(a.quoted_text || "").length > 80 ? "…" : ""}”</span>
                {a.note && <div className="text-muted-foreground mt-0.5">{a.note}</div>}
                {a.finding_id && <div className="text-[10px] font-semibold text-[var(--orange)] mt-0.5">↳ Promoted to finding</div>}
              </div>
              {canAnnotate && (
                <div className="flex gap-1 shrink-0">
                  {!a.finding_id && (
                    <button type="button" title="Promote to Finding" aria-label="Promote annotation to Finding" className="text-[var(--navy)] hover:text-[var(--orange)]" onClick={() => onPromote(a)} data-testid="promote-annotation-btn"><Flag size={13} /></button>
                  )}
                  <button type="button" title="Delete annotation" aria-label="Delete annotation" className="text-muted-foreground hover:text-destructive" onClick={() => onDeleteAnnotation(a)} data-testid="delete-annotation-btn"><X size={13} /></button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
