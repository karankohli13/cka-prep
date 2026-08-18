# CKA Study Hub

Interactive study resources for the **Certified Kubernetes Administrator (CKA)** exam (curriculum v1.35), built from a Pluralsight learning-path transcript set and mapped to the official exam domains.

🔗 **Live site:** https://karankohli13.github.io/cka-prep/

## What's inside

| Module | Description |
|---|---|
| 🗂️ **Flashcards** | 170 cards mixing definitions, concept reviews, and applied scenarios. Filter by domain or card type, flip to reveal, shuffle, keyboard-navigable. |
| 📘 **Study Guide** | Five domain guides with commands, YAML, and 💡 *exam-tip callouts* pulled from the course presenters. Rendered in-browser from markdown. |
| ✅ **Practice Questions** | 300 multiple-choice questions. Choose a batch size (5/15/20/30/all) and domains, see the correct answer + explanation after each question, and get an overall + per-domain score breakdown. Scores are saved in your browser. |

Every flashcard, question, and guide section is tagged with its **CKA exam domain** and a **source reference** back to the originating course/section.

## Exam domain weighting

Content volume is weighted to match the real exam:

| Domain | Weight |
|---|---|
| Troubleshooting | 30% |
| Cluster Architecture, Installation & Configuration | 25% |
| Services & Networking | 20% |
| Workloads & Scheduling | 15% |
| Storage | 10% |

## Repository layout

```
docs/                     ← the published GitHub Pages site
  index.html  flashcards.html  guide.html  practice.html
  assets/                 styles.css, common.js
  data/                   flashcards.json, questions.json, meta.json
  study-guide/            per-domain markdown + manifest.json
content/                  per-domain source output (guides + JSON)
transcripts-text/         plain text extracted from the course PDFs
transcripts/              original course transcript PDFs
CKA_Curriculum_v1.35.pdf  official CKA curriculum
```

## Running locally

It's a static site — no build step:

```bash
cd docs
python3 -m http.server 8000
# open http://localhost:8000
```

## A note on accuracy

Content was generated from the course transcripts and supplemented from official Kubernetes documentation where the transcripts were thin (those items are tagged *"Kubernetes docs"*). It has been spot-checked, but **verify against the [official Kubernetes docs](https://kubernetes.io/docs/home/) before relying on anything for the exam.**
