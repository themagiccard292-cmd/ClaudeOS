"""Safety layer: the C4 rule table and the classifier shared by every gated tool."""

from .classifier import classify, classify_path, classify_shell
from .rules import RULES, Verdict, all_rule_ids

__all__ = ["RULES", "Verdict", "all_rule_ids", "classify", "classify_path", "classify_shell"]
