Feature: WinForms textbox value

  Scenario: The ValueBox control holds the fixture value
    Then the text of control "ValueBox" in window "ui-probe-fixture" is "fixture-value-42"
