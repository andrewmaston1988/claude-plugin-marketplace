Feature: TCP fixture listener

  Scenario: The listener greets with its banner
    Then the TCP banner from port 18773 is "HELLO ui-probe"
