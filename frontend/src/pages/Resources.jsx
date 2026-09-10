import ResourceList from "../components/ResourceList";
import { useNavigate } from "react-router-dom";
import { useCollection } from "../lib/hooks";
import { useAuth } from "../lib/auth";
import {
  PROJECT_SCHEMA,
  MUNICIPALITY_SCHEMA,
  PROPERTY_SCHEMA,
  VerificationBadge,
  createEvidenceSchema,
} from "../lib/resourceSchemas";

export { VerificationBadge };

export function Projects() {
  const navigate = useNavigate();
  return <ResourceList
    {...PROJECT_SCHEMA}
    rowLink={(project) => navigate(`/bassett/issues?project_id=${encodeURIComponent(project.id)}`)}
    rowAction={{
      label: (project) => `Add test run to ${project.name}`,
      onClick: (project) => navigate(`/bassett/issues?project_id=${encodeURIComponent(project.id)}&new_run=1`),
    }}
  />;
}

export function Municipalities() {
  return <ResourceList {...MUNICIPALITY_SCHEMA} />;
}

export function Properties() {
  return <ResourceList {...PROPERTY_SCHEMA} />;
}

export function Evidence() {
  const { data: municipalities = [] } = useCollection("municipalities");
  const { data: users = [] } = useCollection("users");
  const { user } = useAuth();
  return <ResourceList {...createEvidenceSchema(municipalities, users, user)} />;
}
