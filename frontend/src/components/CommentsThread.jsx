import { useState, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Button } from "./ui/button";
import { MessageSquare, Reply, Trash2, Send } from "lucide-react";
import { toast } from "sonner";
import { activeAssignableUsers, userRoleLabel } from "../lib/userValidation";

// Renders comment text with @mentions highlighted in Bassett orange.
function MentionText({ text, mentions = [] }) {
  if (!mentions.length) return <span>{text}</span>;
  const names = mentions.map((m) => m.name).sort((a, b) => b.length - a.length);
  const re = new RegExp(`@(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "g");
  const parts = text.split(re);
  return (
    <span>
      {parts.map((p, i) =>
        names.includes(p) ? (
          <span key={i} className="font-semibold text-[var(--orange)] bg-orange-50 rounded px-0.5" data-testid="mention-chip">@{p}</span>
        ) : (
          <span key={i}>{p}</span>
        )
      )}
    </span>
  );
}

function Composer({ entityType, entityId, parentId, onDone, placeholder }) {
  const qc = useQueryClient();
  const { data: users = [] } = useQuery({ queryKey: ["users"], queryFn: async () => (await api.get("/users")).data });
  const [text, setText] = useState("");
  const [mentions, setMentions] = useState([]);
  const [mentionQuery, setMentionQuery] = useState(null); // null = closed, string = active filter
  const [busy, setBusy] = useState(false);
  const taRef = useRef(null);

  const handleChange = (e) => {
    const v = e.target.value;
    setText(v);
    const caret = e.target.selectionStart;
    const upToCaret = v.slice(0, caret);
    const m = upToCaret.match(/@([\w ]{0,20})$/);
    setMentionQuery(m ? m[1] : null);
  };

  const pickMention = (u) => {
    const caret = taRef.current?.selectionStart ?? text.length;
    const upToCaret = text.slice(0, caret).replace(/@([\w ]{0,20})$/, `@${u.name} `);
    setText(upToCaret + text.slice(caret));
    if (!mentions.find((x) => x.id === u.id)) setMentions([...mentions, { id: u.id, name: u.name }]);
    setMentionQuery(null);
    taRef.current?.focus();
  };

  const submit = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const activeMentions = mentions.filter((m) => text.includes(`@${m.name}`));
      await api.post("/comments", { entity_id: entityId, entity_type: entityType, text: text.trim(), parent_id: parentId || null, mentions: activeMentions });
      setText(""); setMentions([]);
      qc.invalidateQueries({ queryKey: ["comments", entityId] });
      onDone?.();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to post comment");
    } finally { setBusy(false); }
  };

  const suggestions = mentionQuery !== null
    ? activeAssignableUsers(users).filter((u) => u.name.toLowerCase().includes(mentionQuery.toLowerCase())).slice(0, 6)
    : [];

  return (
    <div className="relative">
      <textarea
        ref={taRef}
        rows={parentId ? 2 : 3}
        value={text}
        onChange={handleChange}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(); if (e.key === "Escape") setMentionQuery(null); }}
        placeholder={placeholder || "Add a comment — type @ to mention a teammate…"}
        data-testid={parentId ? "reply-input" : "comment-input"}
        className="w-full text-sm border rounded-lg p-2.5 bg-card focus:outline-none focus:ring-2 focus:ring-[var(--orange)]/40 resize-y"
      />
      {suggestions.length > 0 && (
        <div className="absolute z-30 bg-card border rounded-lg shadow-lg mt-0.5 w-56 overflow-hidden" data-testid="mention-dropdown">
          {suggestions.map((u) => (
            <button key={u.id} type="button" onClick={() => pickMention(u)} data-testid="mention-option"
              className="w-full text-left px-3 py-1.5 text-sm hover:bg-orange-50 flex items-center gap-2">
              <span className="h-5 w-5 rounded-full bg-[var(--navy)] text-white text-[10px] font-bold flex items-center justify-center">{u.name.slice(0, 1)}</span>
              <span className="text-[var(--navy)]">{u.name}</span>
              <span className="text-[10px] text-muted-foreground ml-auto">{userRoleLabel(u.role)}</span>
            </button>
          ))}
        </div>
      )}
      <div className="flex justify-end mt-1.5 gap-2">
        {parentId && <Button size="sm" variant="ghost" onClick={onDone}>Cancel</Button>}
        <Button size="sm" disabled={busy || !text.trim()} onClick={submit} className="bg-[var(--navy)] hover:bg-[#232f73]" data-testid={parentId ? "reply-submit-btn" : "comment-submit-btn"}>
          <Send size={13} className="mr-1" /> {parentId ? "Reply" : "Comment"}
        </Button>
      </div>
    </div>
  );
}

function CommentCard({ c, replies, entityType, entityId, canWrite, user }) {
  const qc = useQueryClient();
  const [replying, setReplying] = useState(false);
  const canDelete = canWrite && (c.author_id === user?.id || ["admin", "qa_manager"].includes(user?.role));

  const remove = async () => {
    await api.delete(`/comments/${c.id}`);
    toast.success("Comment deleted");
    qc.invalidateQueries({ queryKey: ["comments", entityId] });
  };

  return (
    <div className="border rounded-xl p-3 bg-card" data-testid="comment-item">
      <div className="flex items-center gap-2 mb-1">
        <span className="h-6 w-6 rounded-full bg-[var(--navy)] text-white text-[11px] font-bold flex items-center justify-center shrink-0">{(c.author || "?").slice(0, 1)}</span>
        <span className="text-sm font-semibold text-[var(--navy)]">{c.author}</span>
        <span className="text-[11px] text-muted-foreground">{new Date(c.created_at).toLocaleString()}</span>
        <div className="ml-auto flex items-center gap-1">
          {canWrite && !c.deleted && (
            <button className="text-[11px] text-muted-foreground hover:text-[var(--navy)] flex items-center gap-0.5" onClick={() => setReplying(!replying)} data-testid="reply-btn">
              <Reply size={12} /> Reply
            </button>
          )}
          {canDelete && !c.deleted && (
            <button type="button" className="text-muted-foreground hover:text-red-600 ml-1" aria-label="Delete comment" onClick={remove} data-testid="delete-comment-btn" title="Delete comment"><Trash2 size={12} /></button>
          )}
        </div>
      </div>
      {c.deleted
        ? <p className="text-sm italic text-muted-foreground pl-8">— comment deleted —</p>
        : <p className="text-sm prose-response pl-8 whitespace-pre-wrap"><MentionText text={c.text} mentions={c.mentions} /></p>}
      {(replies.length > 0 || replying) && (
        <div className="pl-8 mt-2 space-y-2 border-l-2 border-slate-100 ml-3">
          {replies.map((r) => (
            <div key={r.id} className="pt-1" data-testid="comment-reply">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-[var(--navy)]">{r.author}</span>
                <span className="text-[10px] text-muted-foreground">{new Date(r.created_at).toLocaleString()}</span>
                {canWrite && !r.deleted && (r.author_id === user?.id || ["admin", "qa_manager"].includes(user?.role)) && (
                  <button type="button" aria-label="Delete reply" className="icon-action text-muted-foreground hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange)]" data-testid="delete-reply-btn"
                    onClick={async () => { await api.delete(`/comments/${r.id}`); qc.invalidateQueries({ queryKey: ["comments", entityId] }); }}><Trash2 size={11} /></button>
                )}
              </div>
              {r.deleted
                ? <p className="text-xs italic text-muted-foreground">— comment deleted —</p>
                : <p className="text-sm prose-response whitespace-pre-wrap"><MentionText text={r.text} mentions={r.mentions} /></p>}
            </div>
          ))}
          {replying && <div className="pt-2"><Composer entityType={entityType} entityId={entityId} parentId={c.id} onDone={() => setReplying(false)} placeholder="Write a reply…" /></div>}
        </div>
      )}
    </div>
  );
}

export function CommentsThread({ entityType, entityId, canWrite }) {
  const { user } = useAuth();
  const { data: comments = [] } = useQuery({
    queryKey: ["comments", entityId],
    queryFn: async () => (await api.get(`/comments/${entityId}`)).data,
    enabled: !!entityId,
  });
  const roots = comments.filter((c) => !c.parent_id);
  const repliesFor = (id) => comments.filter((c) => c.parent_id === id);

  return (
    <div data-testid="comments-thread">
      <div className="flex items-center gap-2 mb-3">
        <MessageSquare size={15} className="text-[var(--orange)]" />
        <h3 className="font-semibold font-display text-[var(--navy)] text-sm">Discussion ({comments.filter((c) => !c.deleted).length})</h3>
      </div>
      {canWrite && <div className="mb-4"><Composer entityType={entityType} entityId={entityId} /></div>}
      <div className="space-y-2.5">
        {roots.length === 0 && <p className="text-sm text-muted-foreground">No comments yet — start the discussion above.</p>}
        {roots.map((c) => (
          <CommentCard key={c.id} c={c} replies={repliesFor(c.id)} entityType={entityType} entityId={entityId} canWrite={canWrite} user={user} />
        ))}
      </div>
    </div>
  );
}
