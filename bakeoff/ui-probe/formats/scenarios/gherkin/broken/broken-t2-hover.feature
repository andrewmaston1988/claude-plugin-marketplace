# DELIBERATELY BROKEN: the When step is plausible prose but no binding accepts it,
# and prose alone cannot be executed. The validator must reject it.
Feature: Recommendation hover bar

  Scenario: Hovering a recommendation shows its bar
    Given the fixture sheet page is open
    When the user hovers the first recommendation tile
    Then "[data-testid=hover-bar]" has CSS "opacity" equal to "1"
