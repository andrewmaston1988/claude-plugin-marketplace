Feature: TCP banner from the fixture listener

  Scenario: The listener greets over raw TCP on port 18773
    Then the TCP banner from port 18773 is "HELLO ui-probe"
