export const SIDEBAR_PREFERENCE_PREFIX = "zoneqa.sidebar.groups";

export function sectionId(label) {
  return String(label).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

export function preferenceKey(userId) {
  return `${SIDEBAR_PREFERENCE_PREFIX}.${userId || "anonymous"}`;
}

export function defaultExpanded(sectionIds) {
  return Object.fromEntries(sectionIds.map((id) => [id, id === "overview"]));
}

export function readExpandedPreferences(storage, key, sectionIds) {
  const defaults = defaultExpanded(sectionIds);
  try {
    const parsed = JSON.parse(storage?.getItem(key) || "{}");
    return Object.fromEntries(sectionIds.map((id) => [
      id,
      Object.prototype.hasOwnProperty.call(parsed, id) ? parsed[id] !== false : defaults[id],
    ]));
  } catch {
    return defaults;
  }
}

export function writeExpandedPreferences(storage, key, expanded) {
  try {
    storage?.setItem(key, JSON.stringify(expanded));
  } catch {
    // Browser storage can be unavailable in private browsing; navigation stays usable.
  }
}

export function toggleSection(expanded, id, activeId) {
  // Never hide the group containing the current route.
  if (id === activeId) return { ...expanded, [id]: true };
  return { ...expanded, [id]: !expanded[id] };
}

export function setAllSections(expanded, ids, isExpanded, activeId) {
  return Object.fromEntries(ids.map((id) => [id, isExpanded || id === activeId]));
}

function normalizedPath(pathname) {
  const path = String(pathname || "/").split("#")[0].split("?")[0].replace(/\/+$/, "");
  return path || "/";
}

function locationParts(location) {
  if (typeof location === "string") {
    const withoutHash = location.split("#")[0];
    const queryIndex = withoutHash.indexOf("?");
    return queryIndex >= 0
      ? { pathname: withoutHash.slice(0, queryIndex), search: withoutHash.slice(queryIndex) }
      : { pathname: withoutHash, search: "" };
  }
  return { pathname: location?.pathname || "/", search: location?.search || "" };
}

function targetParts(to) {
  const [path, query = ""] = String(to || "/").split("?");
  return { path: normalizedPath(path), query: new URLSearchParams(query.split("#")[0]) };
}

function queryMatches(targetQuery, actualSearch) {
  const actualQuery = new URLSearchParams(String(actualSearch || "").split("#")[0].replace(/^\?/, ""));
  for (const [key, value] of targetQuery.entries()) {
    if (actualQuery.get(key) !== value) return false;
  }
  return true;
}

export function navItemMatches(item, location) {
  const { pathname, search } = locationParts(location);
  const actualPath = normalizedPath(pathname);
  if (item.routeKey === "bassett-test-runs") {
    const isFindingPath = actualPath === "/bassett/findings"
      || actualPath.startsWith("/bassett/findings/")
      || actualPath === "/bassett/issues/findings"
      || actualPath.startsWith("/bassett/issues/findings/");
    const isRunPath = actualPath === "/bassett/issues" || actualPath.startsWith("/bassett/issues/");
    return isRunPath && !isFindingPath && new URLSearchParams(search).get("view") !== "findings";
  }
  if (item.routeKey === "bassett-findings") {
    const isFindingPath = actualPath === "/bassett/findings"
      || actualPath.startsWith("/bassett/findings/")
      || actualPath === "/bassett/issues/findings"
      || actualPath.startsWith("/bassett/issues/findings/");
    const isSharedList = actualPath === "/bassett/issues"
      && new URLSearchParams(search).get("view") === "findings";
    return isFindingPath || isSharedList;
  }

  const targets = [item.to, ...(item.aliases || [])].map(targetParts);
  return targets.some(({ path, query }) => {
    if (actualPath === path) return queryMatches(query, search);
    if (query.size > 0) return false;
    return actualPath.startsWith(`${path}/`);
  });
}

export function activeSectionId(sections, location) {
  const activeSection = sections.find((section) => section.items.some((item) => navItemMatches(item, location)));
  return activeSection?.id || null;
}

export function visibleSectionItems(section, user) {
  return section.items.filter((item) => {
    const roles = item.roles || (item.adminOnly ? ["admin", "qa_manager"] : null);
    return !roles || roles.includes(user?.role);
  });
}