from property_identity import canonical_property_identity, property_duplicate_key


MUNICIPALITY = {
    "id": "49abba9d-4647-4aad-b970-ec851417c779",
    "name": "City of Milwaukee",
    "state": "Wisconsin",
}


def test_full_combined_address_and_split_fields_have_identical_identity():
    combined = {
        "municipality_id": MUNICIPALITY["id"],
        "address": "6442 N 76th St, Milwaukee, WI 53223",
    }
    split = {
        "municipality_id": MUNICIPALITY["id"],
        "address": "6442 North 76th Street",
        "city": "Milwaukee",
        "state": "Wisconsin",
        "zip": "53223-1234",
    }
    assert property_duplicate_key(combined, MUNICIPALITY) == property_duplicate_key(split, MUNICIPALITY)


def test_municipality_name_and_id_equate_when_lookup_is_supplied():
    by_id = {
        "municipality_id": MUNICIPALITY["id"],
        "address": "6442 N. 76th St.",
        "city": "MILWAUKEE",
        "state": "WI",
        "zip": "53223",
    }
    by_name = {
        "municipality_name": "City of Milwaukee",
        "address": "6442 North 76th Street",
        "city": "Milwaukee",
        "state": "Wisconsin",
        "zip": "53223-0000",
    }
    assert canonical_property_identity(by_id, MUNICIPALITY)[1] == canonical_property_identity(by_name, MUNICIPALITY)[1]