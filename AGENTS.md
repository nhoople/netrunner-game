# Agent notes

These four repositories stay separate: `netrunner-engine`, `netrunner-cards-data`, `netrunner-comprehensive-rules-data`, and `netrunner-game`. The game and the engine consume the others by release tag, not by `master` and not as workspace packages. Cards data and Comprehensive Rules data are datasets with their own versions and CI.

Do not recommend merging the repositories, an npm workspace, or Turborepo unless asked to change that release model.
