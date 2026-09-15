# The Finding DAG

The Finding is not a single opaque blob: every section declares, in `src/lib/finding-dag.ts`,
which inputs and which other sections it depends on. That manifest is the single source of
truth for two things a monolithic report can't otherwise offer — per-section staleness (editing
one input invalidates only its dependents, not the whole report) and this diagram, which is
generated from the manifest by `npm run dag:mermaid` rather than hand-drawn. A unit test
(`tests/unit/finding-dag.test.ts`) pins the block below against the generator's output, so the
picture can never drift from the code. Do not hand-edit between the markers.

<!-- DAG:START -->

```mermaid
graph LR
  aiFindings["LexiTar Findings (disease)"]
  aiHypothesis["LexiTar Hypothesis (alternatives)"]
  aiOnPlan["Plan Assessment"]
  allergyResults["Allergy Result"]
  clinicalSynthesis["Health Synthesis"]
  criticalRatios["Critical Ratios"]
  dataRequisition["Data Requisition"]
  diagnosedDisease["Diagnosed Disease"]
  diseaseResults["Diagnosis Result"]
  doctorConversation["Doctor Conversation"]
  familyResults["Family History Result"]
  finalThoughts["Final Thoughts"]
  healthMarkers["Health Markers"]
  healthProgression["Health Progression"]
  hypothesisEvaluation["Hypothesis Evaluation"]
  labData["Lab data"]
  markerGroups["Marker Groups"]
  markerLevels["Marker Levels"]
  noteResults["Note Result"]
  patientAllergies["Allergies"]
  patientAssessment["Patient Assessment"]
  patientFamilyHistory["Family History"]
  patientHypothesis["Patient Hypothesis"]
  patientPlan["Patient Plan"]
  patternAntipattern["Pattern / Anti-pattern"]
  personalizedRanges["Personalized Ranges"]
  pinnedQueries["Areas of Query"]
  pursuedNotes["Notes"]
  pursuedStudy["Pursued Study"]
  recommendedMarkers["Recommended Markers"]
  statedObjective["Stated Objective"]
  studyResults["Study Result"]
  treatmentAssessment["Treatment Assessment"]
  treatmentGroups["Treatment Groups"]
  treatmentHistory["Treatment History"]
  watchlist["Watchlist"]
  patientAssessment --> aiFindings
  markerLevels --> aiFindings
  patientAssessment --> aiHypothesis
  markerLevels --> aiHypothesis
  aiFindings --> aiHypothesis
  patientPlan --> aiOnPlan
  patientAssessment --> aiOnPlan
  markerLevels --> aiOnPlan
  aiFindings --> aiOnPlan
  hypothesisEvaluation --> aiOnPlan
  patientAssessment --> allergyResults
  markerLevels --> allergyResults
  patientAllergies --> allergyResults
  aiFindings --> allergyResults
  diagnosedDisease --> clinicalSynthesis
  aiFindings --> clinicalSynthesis
  markerLevels --> clinicalSynthesis
  treatmentHistory --> clinicalSynthesis
  labData --> criticalRatios
  diagnosedDisease --> criticalRatios
  aiFindings --> criticalRatios
  aiFindings --> dataRequisition
  markerLevels --> dataRequisition
  patientAssessment --> diseaseResults
  markerLevels --> diseaseResults
  diagnosedDisease --> diseaseResults
  aiFindings --> diseaseResults
  patientAssessment --> doctorConversation
  markerLevels --> doctorConversation
  patientHypothesis --> doctorConversation
  aiFindings --> doctorConversation
  aiHypothesis --> doctorConversation
  hypothesisEvaluation --> doctorConversation
  patientAssessment --> familyResults
  markerLevels --> familyResults
  patientFamilyHistory --> familyResults
  aiFindings --> familyResults
  aiFindings --> finalThoughts
  clinicalSynthesis --> finalThoughts
  hypothesisEvaluation --> finalThoughts
  aiOnPlan --> finalThoughts
  treatmentGroups --> finalThoughts
  watchlist --> healthMarkers
  aiFindings --> healthMarkers
  patientAssessment --> healthProgression
  markerLevels --> healthProgression
  patientAssessment --> hypothesisEvaluation
  markerLevels --> hypothesisEvaluation
  patientHypothesis --> hypothesisEvaluation
  aiFindings --> hypothesisEvaluation
  aiHypothesis --> hypothesisEvaluation
  aiFindings --> markerGroups
  labData --> markerGroups
  watchlist --> markerGroups
  labData --> markerLevels
  patientAssessment --> markerLevels
  statedObjective --> markerLevels
  watchlist --> markerLevels
  diagnosedDisease --> markerLevels
  pinnedQueries --> markerLevels
  recommendedMarkers --> markerLevels
  personalizedRanges --> markerLevels
  patientAssessment --> noteResults
  markerLevels --> noteResults
  pursuedNotes --> noteResults
  aiFindings --> noteResults
  patientAssessment --> patternAntipattern
  markerLevels --> patternAntipattern
  aiFindings --> patternAntipattern
  patientAssessment --> studyResults
  markerLevels --> studyResults
  pursuedStudy --> studyResults
  aiFindings --> studyResults
  patientAssessment --> treatmentAssessment
  markerLevels --> treatmentAssessment
  treatmentHistory --> treatmentAssessment
  aiFindings --> treatmentAssessment
  patientHypothesis --> treatmentGroups
  patientPlan --> treatmentGroups
  aiHypothesis --> treatmentGroups
  aiFindings --> treatmentGroups
```

<!-- DAG:END -->
