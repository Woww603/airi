# Clean-room external-product research

Use this reference when another chat product influences AIRI work.

## Evidence order

1. Official user documentation and published specifications.
2. Release notes and maintainer-authored design documents.
3. Reproducible black-box behavior from a locally installed release.
4. Issue reports only as evidence of limitations, not as the primary contract.

Do not use incompatible copyleft source code as an implementation template for AIRI. Do not paste it into prompts, translate it between languages, preserve its control flow under renamed symbols, or ask another agent to perform a cosmetic rewrite.

## Comparison fixture

Hold these variables constant when comparing chat behavior:

- model and provider;
- temperature, maximum output, stop sequences, and reasoning mode;
- character card and user persona;
- initial conversation and number of prior turns;
- enabled extensions, tools, memory, and retrieval;
- network and device constraints when measuring latency.

Capture the outgoing prompt or prompt itemization when the product exposes it. Attribute differences to prompt construction, retrieval, state, or interaction only after controlling the model.

## Evidence record

For each adopted behavior, record:

- product and version;
- official documentation URL or shared specification;
- observed user behavior;
- AIRI-specific requirement;
- AIRI-owned design decision;
- license and clean-room notes;
- acceptance test.

## Relevant external references

- SillyTavern repository and AGPL notice: `https://github.com/SillyTavern/SillyTavern`
- SillyTavern documentation: `https://docs.sillytavern.app/`
- Character Card V3 specification: `https://github.com/kwaroran/character-card-spec-v3`
- GNU license FAQ for combinations: `https://www.gnu.org/licenses/gpl-faq.html.en`
- GNU AGPLv3 text: `https://www.gnu.org/licenses/agpl-3.0.html.en`

Documentation may describe a useful behavior without defining AIRI's architecture. Re-derive the implementation from AIRI contracts and tests.
