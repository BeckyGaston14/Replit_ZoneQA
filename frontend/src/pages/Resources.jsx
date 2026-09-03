import ResourceList from "../components/ResourceList";
import { useCollection } from "../lib/hooks";
import {
  PROJECT_SCHEMA,
  MUNICIPALITY_SCHEMA,
  PROPERTY_SCHEMA,
  VerificationBadge,
  createEvidenceSchema,
} from "../lib/resourceSchemas";

export { VerificationBadge };

export function Projects() {
  return <ResourceList {...PROJECT_SCHEMA} />;
}

export function Municipalities() {
  return <ResourceList {...MUNICIPALITY_SCHEMA} />;
}

export function Properties() {
  return <ResourceList {...PROPERTY_SCHEMA} />;
}

export function Evidence() {
  const { data: municipalities = [] } = useCollection("municipalities");
  return <ResourceList {...createEvidenceSchema(municipalities)} />;
}