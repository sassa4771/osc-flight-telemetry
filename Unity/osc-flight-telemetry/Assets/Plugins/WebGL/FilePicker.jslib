mergeInto(LibraryManager.library, {
  // C# signature: void FilePicker_OpenFileDialog(string goName, string accept)
  // Emscripten sees pointers, so 'vii' (void, int, int)
  FilePicker_OpenFileDialog__sig: 'vii',
  // Ensure we run on the main thread (safe for future pthread settings)
  FilePicker_OpenFileDialog__proxy: 'sync',

  FilePicker_OpenFileDialog: function (goPtr, acceptPtr) {
    var go = UTF8ToString(goPtr);
    var accept = UTF8ToString(acceptPtr);
    try {
      var input = document.createElement('input');
      input.type = 'file';
      input.style.display = 'none';
      if (accept && accept.length > 0) input.setAttribute('accept', accept);
      document.body.appendChild(input);

      input.addEventListener('change', function () {
        try {
          var file = input.files && input.files[0];
          if (!file) {
            SendMessage(go, 'OnWebGLFilePickError', 'no file selected');
            document.body.removeChild(input);
            return;
          }
          var reader = new FileReader();
          reader.onload = function () {
            try {
              var bytes = new Uint8Array(reader.result);
              var binary = '';
              binary += String.fromCharCode.apply(null, bytes);
              // Fallback for very large files (chunked) to avoid call stack overflow
              // (modern browsers handle apply(null, Uint8Array) up to a limit)
              if (binary.length !== bytes.length) {
                binary = '';
                var chunk = 0x8000;
                for (var i = 0; i < bytes.length; i += chunk) {
                  var sub = bytes.subarray(i, i + chunk);
                  binary += String.fromCharCode.apply(null, sub);
                }
              }
              var b64 = btoa(binary);
              var payload = JSON.stringify({ name: file.name, data: b64 });
              SendMessage(go, 'OnWebGLFilePicked', payload);
            } catch (err) {
              SendMessage(go, 'OnWebGLFilePickError', 'decode error: ' + ('' + err));
            }
            document.body.removeChild(input);
          };
          reader.onerror = function () {
            SendMessage(go, 'OnWebGLFilePickError', 'read error');
            document.body.removeChild(input);
          };
          reader.readAsArrayBuffer(file);
        } catch (err) {
          SendMessage(go, 'OnWebGLFilePickError', '' + err);
          document.body.removeChild(input);
        }
      }, { once: true });

      input.click();
    } catch (e) {
      SendMessage(go, 'OnWebGLFilePickError', '' + e);
    }
  }
});
