Feature: WinForms fixture textbox

  Scenario: The ValueBox control holds the pinned fixture value
    Then the text of control "ValueBox" in window "ui-probe-fixture" is "fixture-value-42"
