Option Explicit

If WScript.Arguments.Count < 2 Then
    WScript.Quit 2
End If

Dim command, index, shell
command = QuoteArgument(WScript.Arguments(0))
For index = 1 To WScript.Arguments.Count - 1
    command = command & " " & QuoteArgument(WScript.Arguments(index))
Next

Set shell = CreateObject("WScript.Shell")
WScript.Quit shell.Run(command, 0, True)

Function QuoteArgument(value)
    QuoteArgument = Chr(34) & Replace(value, Chr(34), Chr(92) & Chr(34)) & Chr(34)
End Function
