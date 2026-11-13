Feature: HTTP health endpoint

  Scenario: The health endpoint reports ok
    Then GET "http://127.0.0.1:18772/health" returns JSON field "ok" equal to "true"
