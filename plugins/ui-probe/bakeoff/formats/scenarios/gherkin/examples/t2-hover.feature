Feature: Recommendation hover bar

  Scenario: A desktop pointer reveals the bar on hover
    Given the viewport is 1280x900
    And the fixture sheet page is open
    When I hover "[data-testid=rec-tile]"
    Then "[data-testid=hover-bar]" has CSS "opacity" equal to "1"

  Scenario: A touch tap leaves the bar hidden
    Given a touch viewport of 390x844
    And the fixture sheet page is open
    When I tap "[data-testid=rec-tile]"
    Then "[data-testid=hover-bar]" has CSS "opacity" equal to "0"
