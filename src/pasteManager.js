const Gdk = imports.gi.Gdk;
const GdkPixbuf = imports.gi.GdkPixbuf;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Gtk = imports.gi.Gtk;
const Polari = imports.gi.Polari;
const Tp = imports.gi.TelepathyGLib;

const ChatroomManager = imports.chatroomManager;
const Lang = imports.lang;
const Utils = imports.utils;

const DndTargetType = {
    URI_LIST: 1,

    TEXT: 2,
    IMAGE: 3,
};

const PasteManager = new Lang.Class({
    Name: 'PasteManager',

    _init: function() {
        this._widgets = [];

        this._dragHighlight = false;
        this._dragDataReceived = false;
        this._dragPending = false;

        this._roomManager = ChatroomManager.getDefault();
    },

    addWidget: function(widget) {
        if (this._widgets.indexOf(widget) != -1)
            return;

        widget.drag_dest_set(0, [], Gdk.DragAction.COPY);

        let targetList = widget.drag_dest_get_target_list();
        if (!targetList)
            targetList = Gtk.TargetList.new([]);

        targetList.add_uri_targets(DndTargetType.URI_LIST);
        targetList.add_text_targets(DndTargetType.TEXT);
        targetList.add_image_targets(DndTargetType.IMAGE, false);

        widget.drag_dest_set_target_list(targetList);

        widget.connect('drag-drop', Lang.bind(this, this._onDragDrop));
        widget.connect('drag-leave', Lang.bind(this, this._onDragLeave));
        widget.connect('drag-motion', Lang.bind(this, this._onDragMotion));
        widget.connect('drag-data-received',
                       Lang.bind(this, this._onDragDataReceived));

        widget.connect('destroy', Lang.bind(this,
            function(w) {
                for (let i = 0; i < this._widgets.length; i++)
                    if (this._widgets[i] == w) {
                        this._widgets.slice(i, 1);
                        break;
                    }
            }));

        this._widgets.push(widget);
    },

    pasteText: function(text) {
        let room = this._roomManager.getActiveRoom();
        if (!room)
            return;

        let nick = room.channel.connection.self_contact.alias;
        Utils.fpaste(text, nick, Lang.bind(this,
            function(url) {
                if (!url)
                    return;

                let type = Tp.ChannelTextMessageType.NORMAL;
                let message = Tp.ClientMessage.new_text(type, url);
                room.channel.send_message_async(message, 0, Lang.bind(this,
                    function(c, res) {
                        try {
                             c.send_message_finish(res);
                        } catch(e) {
                             logError(e, 'Failed to send message')
                        }
                    }));
            }));
    },

    _onDragDrop: function(widget, context, x, y, time) {
        if (!Polari.drag_dest_supports_target(widget, context, null))
            return false;

        Polari.drag_dest_request_data(widget, context, time);
        return true;
    },

    _onDragLeave: function(widget, context, time) {
        widget.drag_unhighlight();
        this._dragHighlight = false;
        this._dragDataReceived = false;
        this._dragPending = false;
    },

    _onDragMotion: function(widget, context, x, y, time) {
        if (!Polari.drag_dest_supports_target(widget, context, null))
            return false;

        let info = Polari.drag_dest_find_target(widget, context);
        switch (info) {
            case DndTargetType.TEXT:
            //case DndTargetType.IMAGE:
                Gdk.drag_status(context, Gdk.DragAction.COPY, time);
                break;
            case DndTargetType.URI_LIST:
                /* FIXME: the latter doesn't seem to work, pretend to support
                          all drops */
                Gdk.drag_status(context, Gdk.DragAction.COPY, time);
                break;

                let action = 0;
                if (!this._dragDataReceived) {
                    this._dragPending = true;
                    Polari.drag_dest_request_data(widget, context, time);
                } else {
                    Gdk.drag_status(context, action, time);
                }
                break;
            default:
                return false;
        }

        if (!this._dragHighlight) {
            this._dragHighlight = true;
            widget.drag_highlight();
        }

        return true;
    },


    _onDragDataReceived: function(widget, context, x, y, data, info, time) {
        if (this._dragPending) {
            this._dragPending = false;

            if (info != DndTargetType.URI_LIST) {
                Gdk.drag_status(context, 0, time);
                return;
            }

            let uris = data.get_uris();
            this._dragDataReceived = true;
            Gdk.drag_status(context, Gdk.DragAction.COPY, time);
            return;
        }

        if (info == DndTargetType.URI_LIST) {
            let uris = data.get_uris();
            if (!uris) {
                Gtk.drag_finish(context, false, false, time);
                return;
            }

            // TODO: handle multiple files ...
            let file = Gio.File.new_for_uri(uris[0]);
            file.query_info_async(Gio.FILE_ATTRIBUTE_STANDARD_CONTENT_TYPE,
                                  Gio.FileQueryInfoFlags.NONE,
                                  GLib.PRIORITY_DEFAULT,
                                  null, Lang.bind(this,
                function(f, res) {
                    let fileInfo = null;
                    try {
                        fileInfo = file.query_info_finish(res);
                    } catch(e) {
                        logError(e);
                        Gtk.drag_finish(context, false, false, time);
                    }

                    let contentType = fileInfo.get_content_type();
                    let targetType = this._getTargetForContentType(contentType);

                    this._handleFileContent(file, targetType);
                    Gtk.drag_finish(context, true, false, time);
                }));
        } else {
            let success = false;
            switch(info) {
                case DndTargetType.TEXT:
                    this.pasteText(data.get_text());
                    success = true;
                    break;
                case DndTargetType.IMAGE:
                    // not implemented
                    //this._pasteImage(data.get_pixbuf());
                    break;
            }
            Gtk.drag_finish(context, success, false, time);
        }
    },

    _getTargetForContentType: function(contentType) {
        if (Gio.content_type_is_a(contentType, 'text/plain'))
            return DndTargetType.TEXT;
        else if (Gio.content_type_is_a(contentType, 'image/*'))
            return DndTargetType.IMAGE;
        else
           return 0;
    },

    _handleFileContent: function(file, type) {
        if (type == DndTargetType.TEXT) {
            file.load_contents_async(null, Lang.bind(this,
                function(f, res) {
                    let [, contents, ,] = f.load_contents_finish(res);
                    this.pasteText(contents.toString());
                }));
        } else if (type == DndTargetType.IMAGE) {
            file.read_async(GLib.PRIORITY_DEFAULT, null, Lang.bind(this,
                function(f, res) {
                    let stream = f.read_finish(res);
                    GdkPixbuf.Pixbuf.new_from_stream_async(stream, null,
                        Lang.bind(this, function(stream, res) {
                            let pixbuf = GdkPixbuf.Pixbuf.new_from_stream_finish(res);
                            this._pasteImage(pixbuf);
                        }));
                }));
        } else {
            log('Unhandled type');
        }
    }
});
