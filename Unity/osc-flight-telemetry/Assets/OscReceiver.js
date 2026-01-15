// Scriptable Item (v1) 用の受信コード
$.onReceiveExternal((args) => {
    // args は Python から送られてきたデータの配列です
    $.log("=== OSCデータを受信しました ($) ===");
    
    // Switch文のようにデータの個数や中身で判定する場合
    if (args.length > 0) {
        for (let i = 0; i < args.length; i++) {
            $.log("データ[" + i + "]: " + args[i]);
        }
    } else {
        $.log("受信したデータは空でした");
    }
});