import { useState } from "react";
import { Button } from "./ui/button";
import { FormModal } from "./forms";
import { readLocalDraft, deleteLocalDraft } from "../lib/localDrafts";
import { toast } from "sonner";

export function LocalDrafts({ mode, onRecover }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(null);
  const [invalid, setInvalid] = useState(false);
  const show = () => {
    try { setDraft(readLocalDraft(mode)); setInvalid(false); }
    catch { setDraft(null); setInvalid(true); }
    setOpen(true);
  };
  const remove = () => {
    try { deleteLocalDraft(mode); setDraft(null); setInvalid(false); toast.success("Draft deleted"); }
    catch { toast.error("Draft could not be deleted"); }
  };
  return <>
    <Button variant="outline" onClick={show}>Drafts</Button>
    {open && <FormModal open title="Saved Drafts" description="Recover or delete the unfinished draft saved in this browser." onOpenChange={setOpen} onSubmit={() => setOpen(false)} submitLabel="Done">
      <p className="text-sm text-muted-foreground">One unfinished draft per testing section is saved on this device and browser. Uploaded files must be reselected after recovery.</p>
      {draft && <div className="rounded-lg border p-3 space-y-3">
        <h3 className="font-semibold">{draft.title || draft.name || "Untitled test"}</h3>
        <p className="text-sm whitespace-pre-wrap break-words">{draft.question_asked || draft.prompts?.[0]?.text || "No prompt entered"}</p>
        <p className="text-sm">Test date: {draft.test_date || "Not entered"}</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => { setOpen(false); onRecover({ ...draft, attachments: [], attachment_count: 0, _draftRecovered: true }); }}>Recover Draft</Button>
          <Button type="button" variant="outline" onClick={remove}>Delete Draft</Button>
        </div>
      </div>}
      {invalid && <div role="alert">This draft cannot be opened. You can delete it and start a new test.<Button type="button" variant="outline" onClick={remove}>Delete Draft</Button></div>}
      {!draft && !invalid && <p>No saved drafts in this testing section.</p>}
    </FormModal>}
  </>;
}
