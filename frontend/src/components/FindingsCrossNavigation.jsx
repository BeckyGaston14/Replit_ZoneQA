import { Link } from "react-router-dom";
import { Button } from "./ui/button";

const FINDINGS_DESTINATIONS = [
  { label: "Bassett Findings", to: "/bassett/findings" },
  { label: "Model Comparison Findings", to: "/findings" },
];

export function FindingsCrossNavigation() {
  return (
    <nav
      aria-label="Findings navigation"
      data-testid="findings-cross-navigation"
      className="flex flex-wrap items-center gap-2"
    >
      {FINDINGS_DESTINATIONS.map(({ label, to }) => (
        <Button key={to} asChild variant="outline">
          <Link to={to} aria-label={label}>{label}</Link>
        </Button>
      ))}
    </nav>
  );
}