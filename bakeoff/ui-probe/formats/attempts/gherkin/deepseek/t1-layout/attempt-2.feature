Feature: Detail sheet action tile widths at 390x844

  Scenario: Each action tile is 111 px wide in a 390x844 touch viewport
    Given a touch viewport of 390x844
    And the fixture sheet page is open
    Then each of "[data-testid=action-tile]" is 111 px wide within 1 px
