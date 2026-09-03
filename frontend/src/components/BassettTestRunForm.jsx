import UnifiedTestEntryForm, {
  BASSETT_RESULT_OPTIONS,
  ScenarioDefinition,
  ScenarioSelector,
  createBassettTestRunDraft,
  emptyBassettTestRun,
} from "./UnifiedTestEntryForm";

export {
  BASSETT_RESULT_OPTIONS,
  ScenarioDefinition,
  ScenarioSelector,
  createBassettTestRunDraft,
  emptyBassettTestRun,
};

export function BassettTestRunForm(props) {
  return <UnifiedTestEntryForm {...props} mode="bassett" />;
}