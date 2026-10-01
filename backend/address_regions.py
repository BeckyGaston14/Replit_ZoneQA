"""Display names for supported address regions; preserve custom lookup entries."""
US_REGIONS = dict(pair.split(":", 1) for pair in (
    "AL:Alabama|AK:Alaska|AZ:Arizona|AR:Arkansas|CA:California|CO:Colorado|CT:Connecticut|DE:Delaware|"
    "DC:District of Columbia|FL:Florida|GA:Georgia|HI:Hawaii|ID:Idaho|IL:Illinois|IN:Indiana|IA:Iowa|"
    "KS:Kansas|KY:Kentucky|LA:Louisiana|ME:Maine|MD:Maryland|MA:Massachusetts|MI:Michigan|MN:Minnesota|"
    "MS:Mississippi|MO:Missouri|MT:Montana|NE:Nebraska|NV:Nevada|NH:New Hampshire|NJ:New Jersey|"
    "NM:New Mexico|NY:New York|NC:North Carolina|ND:North Dakota|OH:Ohio|OK:Oklahoma|OR:Oregon|"
    "PA:Pennsylvania|RI:Rhode Island|SC:South Carolina|SD:South Dakota|TN:Tennessee|TX:Texas|UT:Utah|"
    "VT:Vermont|VA:Virginia|WA:Washington|WV:West Virginia|WI:Wisconsin|WY:Wyoming"
).split("|"))
CA_REGIONS = dict(pair.split(":", 1) for pair in (
    "AB:Alberta|BC:British Columbia|MB:Manitoba|NB:New Brunswick|NL:Newfoundland and Labrador|"
    "NS:Nova Scotia|NT:Northwest Territories|NU:Nunavut|ON:Ontario|PE:Prince Edward Island|"
    "QC:Quebec|SK:Saskatchewan|YT:Yukon"
).split("|"))
REGIONS = {**US_REGIONS, **CA_REGIONS}

def full_region(value):
    text = str(value or "").strip()
    names = {name.casefold(): name for name in REGIONS.values()}
    return REGIONS.get(text.upper(), names.get(text.casefold(), text))

def address_fields(document):
    result = dict(document)
    if "state" in result:
        result["state"] = full_region(result["state"])
    country = str(result.get("country") or "").strip()
    if not country:
        country = "Canada" if result.get("state") in CA_REGIONS.values() else "USA"
    result["country"] = {"us": "USA", "usa": "USA", "united states": "USA", "ca": "Canada", "canada": "Canada"}.get(country.casefold(), country)
    return result
