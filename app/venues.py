"""Venue identity, independent of the nominal home team's market."""

# Stable stadium IDs from nflverse schedules; municipality, not franchise city.
# See documentation/scoreboard.md for venue references and unknown-venue behavior.
STADIUM_CITIES = {
    "ATL97": "Atlanta, GA", "BAL00": "Baltimore, MD", "BOS00": "Foxborough, MA",
    "BUF00": "Orchard Park, NY", "CAR00": "Charlotte, NC", "CHI98": "Chicago, IL",
    "CIN00": "Cincinnati, OH", "CLE00": "Cleveland, OH", "DAL00": "Arlington, TX",
    "DEN00": "Denver, CO", "DET00": "Detroit, MI", "GNB00": "Green Bay, WI",
    "HOU00": "Houston, TX", "IND00": "Indianapolis, IN", "JAX00": "Jacksonville, FL",
    "KAN00": "Kansas City, MO", "LAX01": "Inglewood, CA", "MIA00": "Miami Gardens, FL",
    "MIN01": "Minneapolis, MN", "NAS00": "Nashville, TN", "NOR00": "New Orleans, LA",
    "NYC01": "East Rutherford, NJ", "PHI00": "Philadelphia, PA", "PHO00": "Glendale, AZ",
    "PIT00": "Pittsburgh, PA", "SEA00": "Seattle, WA", "SFO01": "Santa Clara, CA",
    "TAM00": "Tampa, FL", "VEG00": "Paradise, NV", "WAS00": "Landover, MD",
    "MEL00": "Melbourne, Australia", "RIO00": "Rio de Janeiro, Brazil",
    "LON02": "London, UK", "LON00": "London, UK", "PAR00": "Saint-Denis, France",
    "MAD01": "Madrid, Spain", "MUN01": "Munich, Germany", "MEX00": "Mexico City, Mexico",
}

# International rows can retain the nominal home club's usual roof/surface.
VENUE_OVERRIDES = {
    "MEL00": {"roof": "outdoors", "surface": "grass"},
    "RIO00": {"roof": "outdoors", "surface": "grass"},
    "LON02": {"roof": "outdoors", "surface": "artificial"},
    "LON00": {"roof": "outdoors", "surface": "grass"},
    "PAR00": {"roof": "outdoors", "surface": "grass"},
    "MAD01": {"roof": "retractable", "surface": "grass"},
    "MUN01": {"roof": "outdoors", "surface": "grass"},
    "MEX00": {"roof": "outdoors", "surface": "grass"},
}


def venue_overrides(stadium_id, roof=None):
    fields = dict(VENUE_OVERRIDES.get(stadium_id, {}))
    # A retractable roof's reported game-day state is more specific than its design.
    if fields.get("roof") == "retractable" and roof in {"open", "closed"}:
        fields.pop("roof")
    return fields
