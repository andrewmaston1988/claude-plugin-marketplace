Feature: Windows fixture window

  Scenario: The WinForms textbox holds the fixture value
    Then the text of control "ValueBox" in window "ui-probe-fixture" is "fixture-value-42"
