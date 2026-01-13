/**
 * Simple BLE Echo Test for micro:bit + USB Serial Debug
 */
function dbg (tag: string, msg: string) {
    serial.writeLine("" + ts() + " " + tag + " " + msg)
}
bluetooth.onBluetoothConnected(function () {
    basic.showIcon(IconNames.Yes)
    dbg("BLE", "connected")
})
bluetooth.onBluetoothDisconnected(function () {
    basic.showIcon(IconNames.No)
    dbg("BLE", "disconnected")
})
bluetooth.onUartDataReceived(serial.delimiters(Delimiters.NewLine), function () {
    message = bluetooth.uartReadUntil(serial.delimiters(Delimiters.NewLine))
    let clean = message.trim()
dbg("RX", clean)
    // Echo back
    uartTx("ECHO: " + clean)
})
function uartTx (line: string) {
    bluetooth.uartWriteLine(line)
    dbg("TX", line)
}
function ts () {
    // ms since boot is good enough for debugging
    return "[" + input.runningTime() + "ms]"
}
let message = ""
// ------------- USB serial debugging -------------
// Shows up in MakeCode "Show Console" or a serial monitor over USB.
serial.redirectToUSB()
serial.setBaudRate(BaudRate.BaudRate115200)
// ------------- BLE UART -------------
bluetooth.startUartService()
dbg("BOOT", "BLE UART started")
basic.forever(function () {
    basic.pause(100)
})

