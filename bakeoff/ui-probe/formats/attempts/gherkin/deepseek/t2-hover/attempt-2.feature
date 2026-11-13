Feature: Recommendation hover bar is pointer-capability aware

  Scenario: Hovering a recommendation tile on a desktop viewport reveals its hover bar
    Given the viewport is 1280x900
    And the fixture sheet page is open
    When I hover "[data-testid=recommendation-tile]"
    Then "[data-testid=hover-bar]" has CSS "opacity" equal to "1"

  Scenario: Tapping a recommendation tile on a touch viewport leaves its hover bar hidden
    Given a touch viewport of 390x844
    And the fixture sheet page is open
    When I tap "[data-testid=recommendation-tile]"
    Then "[data-testid=hover-bar]" has CSS "opacity" equal to "0"
