// Simple BLE Echo Test for micro:bit
bluetooth.startUartService()

basic.showIcon(IconNames.Happy)

bluetooth.onBluetoothConnected(function () {
    basic.showIcon(IconNames.Yes)
    bluetooth.uartWriteLine("CONNECTED")
})

bluetooth.onBluetoothDisconnected(function () {
    basic.showIcon(IconNames.No)
    bluetooth.uartWriteLine("DISCONNECTED")
})

bluetooth.onUartDataReceived(serial.delimiters(Delimiters.NewLine), function () {
    let message = bluetooth.uartReadUntil(serial.delimiters(Delimiters.NewLine))

    // Show heart when receiving
    basic.showIcon(IconNames.Heart)
    basic.pause(200)
    basic.clearScreen()

    // Echo back
    bluetooth.uartWriteLine("ECHO: " + message)
})
