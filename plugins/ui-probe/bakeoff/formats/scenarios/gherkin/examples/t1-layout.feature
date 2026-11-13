Feature: Detail sheet layout at phone width

  Scenario: Action tiles are 111 px wide at 390x844
    Given a touch viewport of 390x844
    And the fixture sheet page is open
    Then each of "[data-testid=action-tile]" is 111 px wide within 1 px
