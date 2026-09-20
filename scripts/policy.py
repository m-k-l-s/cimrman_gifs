"""Reviewed programme aliases and exact keyword noise; no fuzzy inference."""

import unicodedata
from dataclasses import dataclass


def fold_text(value: str) -> str:
    return (
        "".join(
            char for char in unicodedata.normalize("NFD", value) if not "\u0300" <= char <= "\u036f"
        )
        .strip()
        .lower()
    )


PUBLISHER_ALIASES = frozenset(
    {
        "ceskatelevize",
        "czechtv",
        "televize",
        "ceska",
        "ceska televize",
        "ct",
        "ivysilani",
        "ceskatelevice",
        "ceskatelecize",
    }
)


@dataclass(frozen=True)
class ProgrammeRule:
    label: str
    tags: frozenset[str]
    common_tags: frozenset[str] = frozenset()


PROGRAMME_RULES = {
    "andel-pane": ProgrammeRule("Anděl Páně", frozenset({"andelpane", "andelpane2"})),
    "bozena": ProgrammeRule("Božena", frozenset({"bozena"})),
    "chalupari": ProgrammeRule("Chalupáři", frozenset({"chalupari"})),
    "chi-chi-na-gauci": ProgrammeRule(
        "Chi Chi na gauči", frozenset({"chichinagauci", "chichinagauči"})
    ),
    "cimrmani": ProgrammeRule(
        "Cimrman",
        frozenset({"cimrman", "cimrmani", "cimrmana", "divadlojarycimrmana"}),
        frozenset({"divadlo", "jary", "djc"}),
    ),
    "dobre-rano-brno": ProgrammeRule("Dobré ráno, Brno!", frozenset({"dobreranobrno"})),
    "limity": ProgrammeRule("Limity", frozenset({"limity"})),
    "limonadovy-joe": ProgrammeRule("Limonádový Joe", frozenset({"limonadovyjoe"})),
    "navstevnici": ProgrammeRule("Návštěvníci", frozenset({"navstevnici"})),
    "osada": ProgrammeRule("Osada", frozenset({"osada"})),
    "pece-cela-zeme": ProgrammeRule("Peče celá země", frozenset({"pececelazeme"})),
    "pelisky": ProgrammeRule("Pelíšky", frozenset({"pelisky", "pelíšky"})),
    "prvni-republika": ProgrammeRule("První republika", frozenset({"prvnirepublika"})),
    "stardance-x": ProgrammeRule("StarDance X", frozenset({"stardance10"})),
    "stardance-xi": ProgrammeRule("StarDance XI", frozenset({"stardancexi"})),
    "stardance-xii": ProgrammeRule("StarDance XII", frozenset({"stardancexii"})),
    "stardance-xiii": ProgrammeRule("StarDance XIII", frozenset({"stardancexiii"})),
    "tomas-holy": ProgrammeRule(
        "Tomáš Holý", frozenset({"tomasholy"}), frozenset({"tomas", "holy"})
    ),
    "vecernicek": ProgrammeRule("Večerníček", frozenset({"vecernicek"})),
    "zkaza-dejvickeho-divadla": ProgrammeRule(
        "Zkáza Dejvického divadla", frozenset({"zkazadejvickehodivadla"})
    ),
}
