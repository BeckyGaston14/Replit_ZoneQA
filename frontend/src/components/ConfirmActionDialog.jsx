import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "./ui/alert-dialog";

export function ConfirmActionDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  onConfirm,
  busy = false,
  destructive = false,
  children,
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            className={destructive ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : ""}
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
          >
            {busy ? "Working…" : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}