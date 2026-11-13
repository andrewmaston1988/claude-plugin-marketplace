Feature: Recommendation hover bar

  Scenario: Hover bar becomes fully visible on desktop hover
    Given the fixture sheet page is open
    Given the viewport is 1280x900
    When I hover "[data-testid=recommendation-tile]:first-child"
    Then "[data-testid=hover-bar]" has CSS "opacity" equal to "1"

  Scenario: Hover bar stays hidden on touch tap
    Given the fixture sheet page is open
    Given a touch viewport of 390x844
    When I tap "[data-testid=recommendation-tile]:first-child"
    Then "[data-testid=hover-bar]" has CSS "opacity" equal to "0"
