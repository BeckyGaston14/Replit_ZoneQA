import UnifiedTestEntryForm, {
  BASSETT_RESULT_OPTIONS,
  TURN_RESULT_OPTIONS,
  ScenarioDefinition,
  ScenarioSelector,
  createBassettTestRunDraft,
  emptyBassettTestRun,
  serializeBassettTestRunDraft,
} from "./UnifiedTestEntryForm";

export {
  BASSETT_RESULT_OPTIONS,
  TURN_RESULT_OPTIONS,
  ScenarioDefinition,
  ScenarioSelector,
  createBassettTestRunDraft,
  emptyBassettTestRun,
  serializeBassettTestRunDraft,
};

export function BassettTestRunForm(props) {
  return <UnifiedTestEntryForm {...props} mode="bassett" />;
}