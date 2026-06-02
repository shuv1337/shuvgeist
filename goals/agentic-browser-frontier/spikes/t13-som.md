# SPIKE-T13 - Set-of-Marks Vision Baseline

Date: 2026-06-01

## Question

Do numbered visual badges over candidate bounding boxes beat the cheaper baseline of a screenshot plus structured candidate JSON for ambiguous element resolution on the default/free-tier model path?

## Method

Live model calls could not be performed in this environment:

- No provider API credentials were present in the environment.
- The bundled free-tier endpoint http://shuvdev:8789/v1 was unreachable from this checkout.

Given that limitation, this spike measured the concrete product payload and implementation tradeoff using the current direct-CDP/snapshot foundations:

1. Launch no-extension headless Chromium with a disposable profile.
2. Open a synthetic invoice-review page with eight visually similar buttons.
3. Capture semantic candidates with the canonical SNAPSHOT_PAGE_SCRIPT.
4. Build the baseline payload: plain screenshot plus candidate JSON.
5. Add numbered badges over every candidate bounding box in the page.
6. Capture the annotated screenshot payload.
7. Compare payload sizes and whether the structured candidates alone identify the target.

Fixture instruction: Choose the control that archives the selected invoice.

## Result

The local payload spike passed, but live model comparison is not proven:

    {
      "ok": true,
      "modelLiveComparison": false,
      "missingModelReason": "No provider credentials in environment and bundled free-tier endpoint http://shuvdev:8789/v1 was unreachable.",
      "target": {
        "mark": 1,
        "ref": "e3",
        "role": "button",
        "name": "Archive selected invoice",
        "bbox": {
          "x": 28,
          "y": 149.875,
          "width": 140,
          "height": 74
        }
      },
      "candidateCount": 8,
      "structuredCandidatePayloadBytes": 1049,
      "plainScreenshotBytes": 13373,
      "annotatedScreenshotBytes": 19192,
      "annotatedOverPlainDeltaBytes": 5819,
      "annotatedOverPlainDeltaPercent": 43.51,
      "baselinePayloadBytes": 14422,
      "annotatedOnlyPayloadBytes": 19192,
      "structuredCandidateWouldResolve": true
    }

## Findings

- The structured candidate list already identifies the intended target on this fixture: mark 1 / ref e3 / role button / name Archive selected invoice.
- The baseline payload of plain screenshot plus candidate JSON was 14,422 bytes.
- The annotated screenshot alone was 19,192 bytes, 5,819 bytes larger than the plain screenshot and 43.51% larger than the plain screenshot.
- Annotated screenshots require mutating the page or using a screenshot overlay pipeline before capture.
- The current snapshot contract already contains candidate ids, names, roles, and bounding boxes needed for a screenshot plus candidate JSON baseline.
- The requested live comparison on default/free-tier models could not be completed in this environment.

## Caveats

- This is not a model accuracy result. It is payload and implementation evidence only.
- The fixture has accessible labels. SoM may still help when the visible layout is semantically poor, candidate names are duplicated, or the model must reason spatially.
- Annotating the live page is risky for product code. A production SoM implementation should draw overlays off-page or on a screenshot copy, not mutate customer DOM by default.
- The free-tier endpoint should be reachable before treating T13 as fully evaluated against the product default path.

## Recommendation

Do not implement a general numbered-badge SoM path yet.

Recommended T13 shape if approved later:

- Start with screenshot plus structured candidate JSON as the vision fallback baseline.
- Gate it to vision-capable providers only.
- Trigger it from the planner-validator failure/ambiguity signal, never by default.
- Keep captureAnnotatedScreenshot out of ExtractImageTool.execute.
- Add numbered badge overlays only after a live model eval shows they beat structured candidates on harder ambiguous fixtures.

Because the live default/free-tier model comparison is missing, this spike should be treated as a partial T13 gate. It supports reshaping T13 toward a cheaper structured-candidate baseline first, but it does not prove SoM should ship.

## Gate Status

SPIKE-T13 produced local payload evidence but did not complete the required live model comparison. Stop here until the user decides whether to approve the reshaped T13 baseline, rerun with reachable model credentials, or defer T13.
