"""Canonical property identity used by API validation and PostgreSQL storage.

This module is deliberately free of database dependencies. Callers may pass
looked-up municipality data so an ID and its display name resolve identically.
"""

import re
import unicodedata

STATE_ALIASES = {
    "alabama": "al", "alaska": "ak", "arizona": "az", "arkansas": "ar",
    "california": "ca", "colorado": "co", "connecticut": "ct", "florida": "fl",
    "georgia": "ga", "illinois": "il", "indiana": "in", "iowa": "ia",
    "michigan": "mi", "minnesota": "mn", "missouri": "mo", "montana": "mt",
    "nebraska": "ne", "nevada": "nv", "new jersey": "nj", "new mexico": "nm",
    "new york": "ny", "north carolina": "nc", "north dakota": "nd",
    "ohio": "oh", "oklahoma": "ok", "oregon": "or", "pennsylvania": "pa",
    "south carolina": "sc", "south dakota": "sd", "tennessee": "tn", "texas": "tx",
    "utah": "ut", "vermont": "vt", "virginia": "va", "washington": "wa",
    "west virginia": "wv", "wisconsin": "wi", "wyoming": "wy",
    "district of columbia": "dc",
}
STATE_ALIASES.update({value: value for value in STATE_ALIASES.values()})

STREET_ALIASES = {
    "avenue": "ave", "av": "ave", "boulevard": "blvd", "bl": "blvd",
    "circle": "cir", "court": "ct", "drive": "dr", "highway": "hwy",
    "lane": "ln", "parkway": "pkwy", "place": "pl", "road": "rd",
    "street": "st", "terrace": "ter", "trail": "trl", "way": "way",
    "north": "n", "south": "s", "east": "e", "west": "w",
}


def normalize_text(value) -> str:
    value = unicodedata.normalize("NFKD", str(value or ""))
    value = "".join(char for char in value if not unicodedata.combining(char))
    value = value.casefold().replace("&", " and ")
    value = re.sub(r"[\s.,#'/\\\-]+", " ", value)
    value = " ".join(value.split())
    for source, replacement in STREET_ALIASES.items():
        value = re.sub(rf"\b{re.escape(source)}\b", replacement, value)
    return " ".join(value.split())


def normalize_state(value) -> str:
    return STATE_ALIASES.get(normalize_text(value), normalize_text(value))


def normalize_zip(value) -> str:
    digits = re.sub(r"\D", "", str(value or ""))
    return digits[:5]


def _split_combined_address(address):
    text = str(address or "").strip()
    match = re.match(
        r"^\s*(.+?),\s*([^,]+),\s*([A-Za-z .]+?)\s+(\d{5}(?:-\d{4})?)\s*$",
        text,
    )
    if not match:
        return text, None, None, None
    return match.group(1).strip(), match.group(2).strip(), match.group(3).strip(), match.group(4)


def canonical_property_identity(document, municipality=None):
    """Return normalized fields and the canonical identity tuple.

    `municipality` is an optional trusted municipality row. It lets callers
    equate municipality ID and municipality name representations without
    guessing from arbitrary text.
    """
    source = dict(document or {})
    address = source.get("address") or source.get("street_address")
    city = source.get("city") or source.get("municipality_city")
    state = source.get("state") or source.get("municipality_state")
    postal = source.get("zip") or source.get("zipcode") or source.get("zip_code") or source.get("postal_code")
    split_address, split_city, split_state, split_zip = _split_combined_address(address)
    if split_city:
        address, city, state, postal = split_address, city or split_city, state or split_state, postal or split_zip
    municipality_id = source.get("municipality_id")
    municipality_name = source.get("municipality_name") or source.get("municipality")
    if isinstance(municipality_name, dict):
        municipality = municipality or municipality_name
        municipality_name = municipality.get("name")
    if municipality:
        municipality_id = municipality_id or municipality.get("id")
        municipality_name = municipality_name or municipality.get("name")
        city = city or municipality.get("name")
        state = state or municipality.get("state")
    municipality_key = str(municipality_id or normalize_text(municipality_name))
    fields = {
        "address": address or "",
        "city": city or "",
        "state": state or "",
        "zip": postal or "",
        "municipality_id": municipality_id,
        "municipality_name": municipality_name,
    }
    identity = (
        normalize_text(municipality_key),
        normalize_text(fields["address"]),
        normalize_text(fields["city"]),
        normalize_state(fields["state"]),
        normalize_zip(fields["zip"]),
    )
    return fields, identity


def property_duplicate_key(document, municipality=None) -> str:
    return "|".join(canonical_property_identity(document, municipality)[1])