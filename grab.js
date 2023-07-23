const Module = imports.misc.extensionUtils.getCurrentExtension().imports.module;
const Settings = Module.Settings();
const { Meta, Clutter, St, Graphene } = imports.gi;
const Main = imports.ui.main;
const Mainloop = imports.mainloop;

const Easer = Module.Extension.imports.utils.easer;

var virtualPointer;

function isInRect(x, y, r) {
    return r.x <= x && x < r.x + r.width &&
        r.y <= y && y < r.y + r.height;
}

function monitorAtPoint(gx, gy) {
    for (let monitor of Main.layoutManager.monitors) {
        if (isInRect(gx, gy, monitor))
            return monitor;
    }
    return null;
}

/**
 * Returns a virtual pointer (i.e. mouse) device that can be used to
 * "clickout" of a drag operation when `grab_end_op` is unavailable
 * (i.e. as of Gnome 44 where `grab_end_op` was removed).
 * @returns Clutter.VirtualInputDevice
 */
function getVirtualPointer() {
    if (!virtualPointer) {
        virtualPointer = Clutter.get_default_backend()
            .get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    }

    return virtualPointer;
}

var MoveGrab = class MoveGrab {
    constructor(metaWindow, type, space) {
        this.window = metaWindow;
        this.type = type;
        this.signals = Module.Signals();
        this.grabbed = false;

        this.initialSpace = space || Module.Tiling().spaces.spaceOfWindow(metaWindow);
        this.zoneActors = new Set();

        // save whether this was tiled window at start of grab
        this.wasTiled = !(this.initialSpace.isFloating(metaWindow) ||
            Module.Scratch().isScratchWindow(metaWindow));
    }

    begin({center} = {}) {
        Module.Utils().debug("#grab", "begin");

        this.center = center;
        if (this.grabbed)
            return;

        this.grabbed = true;
        global.display.end_grab_op?.(global.get_current_time());
        global.display.set_cursor(Meta.Cursor.MOVE_OR_RESIZE_WINDOW);
        this.dispatcher = new Module.Extension.imports.navigator.getActionDispatcher(Clutter.GrabState.POINTER);
        this.actor = this.dispatcher.actor;

        for (let [monitor, $] of Module.Tiling().spaces.monitors) {
            monitor.clickOverlay.deactivate();
        }

        let metaWindow = this.window;
        let actor = metaWindow.get_compositor_private();
        let clone = metaWindow.clone;
        let space = this.initialSpace;
        let frame = metaWindow.get_frame_rect();

        this.initialY = clone.targetY;
        Easer.removeEase(clone);
        let [gx, gy, $] = global.get_pointer();

        let px = (gx - actor.x) / actor.width;
        let py = (gy - actor.y) / actor.height;
        actor.set_pivot_point(px, py);

        let [x, y] = space.globalToScroll(gx, gy);
        if (clone.get_parent() === this.initialSpace.cloneContainer) {
            this.pointerOffset = [x - clone.x, y - clone.y];
            px = (x - clone.x) / clone.width;
            py = (y - clone.y) / clone.height;
        } else {
            this.pointerOffset = [gx - frame.x, gy - frame.y];
            clone.x = frame.x;
            clone.y = frame.y;
            px = (gx - clone.x) / clone.width;
            py = (gy - clone.y) / clone.height;
        }
        !center && clone.set_pivot_point(px, py);
        center && clone.set_pivot_point(0, 0);

        this.signals.connect(this.actor, "button-release-event", this.end.bind(this));
        this.signals.connect(this.actor, "motion-event", this.motion.bind(this));
        this.signals.connect(
            global.screen || global.display, "window-entered-monitor",
            this.beginDnD.bind(this)
        );

        this.scrollAnchor = x;
        space.startAnimate();
        // Make sure the window actor is visible
        Module.Navigator().getNavigator();
        Module.Tiling().animateWindow(metaWindow);
        Easer.removeEase(space.cloneContainer);
    }

    beginDnD({center} = {}) {
        if (this.dnd)
            return;
        this.center = center;
        this.dnd = true;
        Module.Utils().debug("#grab", "begin DnD");
        Module.Navigator().getNavigator().minimaps.forEach(m => typeof m === 'number'
            ? Mainloop.source_remove(m) : m.hide());
        global.display.set_cursor(Meta.Cursor.MOVE_OR_RESIZE_WINDOW);
        let metaWindow = this.window;
        let clone = metaWindow.clone;
        let space = this.initialSpace;

        let [gx, gy, $] = global.get_pointer();
        let point = {};
        if (center) {
            point = space.cloneContainer.apply_relative_transform_to_point(
                global.stage, new Graphene.Point3D({x: Math.round(clone.x), y: Math.round(clone.y)}));
        } else {
            // For some reason the above isn't smooth when DnD is triggered from dragging
            let [dx, dy] = this.pointerOffset;
            point.x = gx - dx;
            point.y = gy - dy;
        }

        let i = space.indexOf(metaWindow);
        let single = i !== -1 && space[i].length === 1;
        space.removeWindow(metaWindow);
        Module.Utils().actor_reparent(clone, Main.uiGroup);
        clone.x = Math.round(point.x);
        clone.y = Math.round(point.y);
        let newScale = clone.scale_x * space.actor.scale_x;
        clone.set_scale(newScale, newScale);

        let params = {time: Settings.prefs.animation_time, scale_x: 0.5, scale_y: 0.5, opacity: 240}
        if (center) {
            this.pointerOffset = [0, 0];
            clone.set_pivot_point(0, 0);
            params.x = gx;
            params.y = gy;
        }

        clone.__oldOpacity = clone.opacity;
        Easer.addEase(clone, params);

        this.signals.connect(global.stage, "button-press-event", this.end.bind(this));

        let monitor = monitorAtPoint(gx, gy);

        let onSame = monitor === space.monitor;

        let [x, y] = space.globalToViewport(gx, gy);
        if (!this.center && onSame && single && space[i]) {
            Module.Tiling().move_to(space, space[i][0], {x: x + Settings.prefs.window_gap / 2});
        } else if (!this.center && onSame && single && space[i - 1]) {
            Module.Tiling().move_to(space, space[i - 1][0], {x: x - space[i - 1][0].clone.width - Settings.prefs.window_gap / 2});
        } else if (!this.center && onSame && space.length === 0) {
            space.targetX = x;
            space.cloneContainer.x = x;
        }

        let [sx, sy] = space.globalToScroll(gx, gy, {useTarget: true});

        for (let [workspace, space] of Module.Tiling().spaces) {
            this.signals.connect(space.background, "motion-event", this.spaceMotion.bind(this, space));
        }
        this.selectDndZone(space, sx, sy, single && onSame);
    }

    spaceMotion(space, background, event) {
        let [gx, gy, $] = global.get_pointer();
        let [sx, sy] = space.globalToScroll(gx, gy, {useTarget: true});
        this.selectDndZone(space, sx, sy);
    }

    /** x,y in scroll cooridinates */
    selectDndZone(space, x, y, initial=false) {
        const gap = Settings.prefs.window_gap;
        const halfGap = gap / 2;
        const columnZoneMarginViz = 100 + halfGap;
        const columnZoneMargin = space.length > 0 ? columnZoneMarginViz : Math.round(space.width / 4);
        const rowZoneMargin = 250 + halfGap;

        let target = null;
        const tilingHeight = space.height - Main.layoutManager.panelBox.height;

        let fakeClone = {
            targetX: null,
            targetY: 0,
            width: columnZoneMargin,
            height: tilingHeight
        };
        if (space.length > 0) {
            const lastClone = space[space.length - 1][0].clone;
            fakeClone.targetX = lastClone.x + lastClone.width + gap;
        } else {
            let [sx, sy] = space.viewportToScroll(Math.round(space.width/2), 0);
            fakeClone.targetX = sx + halfGap;
        }

        const columns = [...space, [{ clone: fakeClone }]];
        for (let j = 0; j < columns.length; j++) {
            const column = columns[j];
            const metaWindow = column[0];
            const clone = metaWindow.clone;

            // FIXME: Non-uniform column width
            const colX = clone.targetX;
            const colW = clone.width;

            // Fast forward if pointer is not inside the column or the column zone
            if (x < colX - gap - columnZoneMargin) {
                continue;
            }
            if (colX + colW < x) {
                continue;
            }

            const cx = colX - halfGap;
            const l = cx - columnZoneMargin;
            const r = cx + columnZoneMargin;
            if (l <= x && x <= r) {
                target = {
                    position: [j],
                    center: cx,
                    originProp: "x",
                    sizeProp: "width",
                    marginA: columnZoneMarginViz,
                    marginB: columnZoneMarginViz,
                    space: space,
                    actorParams: {
                        y: Main.layoutManager.panelBox.height,
                        height: tilingHeight
                    }
                };
                break;
            }

            // Must be strictly within the column to tile vertically
            if (x < colX)
                continue;

            for (let i = 0; i < column.length + 1; i++) {
                let clone;
                if (i < column.length) {
                    clone = column[i].clone;
                } else {
                    let lastClone = column[i-1].clone;
                    clone = {
                        targetX: lastClone.targetX,
                        targetY: lastClone.targetY + lastClone.height + gap,
                        width: lastClone.width,
                        height: 0
                    };
                }
                const isFirst = i === 0;
                const isLast = i === column.length;
                const cy = clone.targetY - halfGap;
                const t = cy - rowZoneMargin;
                const b = cy + rowZoneMargin;
                if (t <= y && y <= b) {
                    target = {
                        position: [j, i],
                        center: cy,
                        originProp: "y",
                        sizeProp: "height",
                        marginA: isFirst ? 0 : rowZoneMargin,
                        marginB: isLast  ? 0 : rowZoneMargin,
                        space: space,
                        actorParams: {
                            x: clone.targetX,
                            width: clone.width,
                        }
                    };
                    break;
                }
            }
        }

        function sameTarget(a, b) {
            if (a === b)
                return true;
            if (!a || !b)
                return false;
            return a.space === b.space && a.position[0] === b.position[0] && a.position[1] === b.position[1];
        }

        // TODO: rename dndTarget to selectedZone ?
        if (!sameTarget(target, this.dndTarget)) {
            this.dndTarget && this.deactivateDndTarget(this.dndTarget);
            if (target)
                this.activateDndTarget(target, initial);
        }
    }

    motion(actor, event) {
        let metaWindow = this.window;
        // let [gx, gy] = event.get_coords();
        let [gx, gy, $] = global.get_pointer();
        let [dx, dy] = this.pointerOffset;
        let clone = metaWindow.clone;

        let tx = clone.get_transition('x')
        let ty = clone.get_transition('y')

        if (this.dnd) {
            if (tx) {
                tx.set_to(gx - dx)
                ty.set_to(gy - dy)
            } else {
                clone.x = gx - dx;
                clone.y = gy - dy;
            }
        } else {
            let monitor = monitorAtPoint(gx, gy);
            if (monitor !== this.initialSpace.monitor) {
                this.beginDnD();
                return;
            }

            if (event.get_state() & Clutter.ModifierType.CONTROL_MASK) {
                // NB: only works in wayland
                this.beginDnD();
                return;
            }

            let space = this.initialSpace;
            let clone = metaWindow.clone;
            let [x, y] = space.globalToViewport(gx, gy);
            space.targetX = x - this.scrollAnchor;
            space.cloneContainer.x = space.targetX;

            clone.y = y - dy;

            const threshold = 300;
            dy = Math.min(threshold, Math.abs(clone.y - this.initialY));
            let s = 1 - Math.pow(dy / 500, 3);
            let actor = metaWindow.get_compositor_private();
            actor.set_scale(s, s);
            clone.set_scale(s, s);

            if (dy >= threshold) {
                this.beginDnD();
            }
        }
    }

    end() {
        Module.Utils().debug("#grab", "end");
        this.signals.destroy();

        let metaWindow = this.window;
        let actor = metaWindow.get_compositor_private();
        let frame = metaWindow.get_frame_rect();
        let clone = metaWindow.clone;
        let destSpace;
        let [gx, gy, $] = global.get_pointer();

        this.zoneActors.forEach(actor => actor.destroy());
        let params = {
            time: Settings.prefs.animation_time,
            scale_x: 1,
            scale_y: 1,
            opacity: clone?.__oldOpacity ?? 255,
        };

        if (this.dnd) {
            let dndTarget = this.dndTarget;

            if (dndTarget) {
                let space = dndTarget.space;
                destSpace = space;
                space.selection.show();

                if (Module.Scratch().isScratchWindow(metaWindow))
                    Module.Scratch().unmakeScratch(metaWindow);

                // Remember the global coordinates of the clone
                let [x, y] = clone.get_position();
                space.addWindow(metaWindow, ...dndTarget.position);

                let [sx, sy] = space.globalToScroll(gx, gy);
                let [dx, dy] = this.pointerOffset;
                clone.x = sx - dx;
                clone.y = sy - dy;
                let newScale = clone.scale_x/space.actor.scale_x;
                clone.set_scale(newScale, newScale);

                actor.set_scale(1, 1);
                actor.set_pivot_point(0, 0);

                // Tiling.animateWindow(metaWindow);
                params.onStopped = () => {
                    space.moveDone()
                    clone.set_pivot_point(0, 0)
                }
                Easer.addEase(clone, params);

                space.targetX = space.cloneContainer.x;
                space.selectedWindow = metaWindow;
                if (dndTarget.position) {
                    space.layout(true, {customAllocators: {[dndTarget.position[0]]: Module.Tiling().allocateEqualHeight}});
                } else {
                    space.layout();
                }
                Module.Tiling().move_to(space, metaWindow, {x: x - space.monitor.x})
                Module.Tiling().ensureViewport(metaWindow, space);

                Module.Utils().actor_raise(clone);
            } else {
                metaWindow.move_frame(true, clone.x, clone.y);
                Module.Scratch().makeScratch(metaWindow);
                this.initialSpace.moveDone();

                actor.set_scale(clone.scale_x, clone.scale_y);
                actor.opacity = clone.opacity;

                clone.opacity = clone.__oldOpacity || 255;
                clone.set_scale(1, 1);
                clone.set_pivot_point(0, 0);

                params.onStopped = () => { actor.set_pivot_point(0, 0) };
                Easer.addEase(actor, params);
            }

            Module.Navigator().getNavigator().accept();
        } else if (this.initialSpace.indexOf(metaWindow) !== -1) {
            let space = this.initialSpace;
            destSpace = space;
            space.targetX = space.cloneContainer.x;

            actor.set_scale(1, 1);
            actor.set_pivot_point(0, 0);

            Module.Tiling().animateWindow(metaWindow);
            params.onStopped = () => {
                space.moveDone();
                clone.set_pivot_point(0, 0);
            }
            Easer.addEase(clone, params);

            Module.Tiling().ensureViewport(metaWindow, space);
            Module.Navigator().getNavigator().accept();
        }

        // NOTE: we reset window here so `window-added` will handle the window,
        // and layout will work correctly etc.
        this.window = null;

        this.initialSpace.layout();
        // ensure window is properly activated after layout/ensureViewport tweens
        Module.Utils().later_add(Meta.LaterType.IDLE, () => {
            Main.activateWindow(metaWindow);
        });

        // // Make sure the window is on the correct workspace.
        // // If the window is transient this will take care of its parent too.
        // metaWindow.change_workspace(space.workspace)
        // space.workspace.activate(global.get_current_time());
        Module.Tiling().inGrab = false;
        if (this.dispatcher) {
            Module.Navigator().dismissDispatcher(Clutter.GrabState.POINTER)
        }

        global.display.set_cursor(Meta.Cursor.DEFAULT);

        /**
         * Gnome 44 removed the ability to manually end_grab_op.
         * Previously we would end the grab_op before doing
         * PaperWM grabs.  In 44, we can't do this so the grab op
         * may still be in progress, which is okay, but won't be ended
         * until we "click out".  We do this here if needed.
         */
        Module.Utils().later_add(Meta.LaterType.IDLE, () => {
            if (!global.display.end_grab_op && this.wasTiled) {
                // move to current cursort position
                let [x, y, _mods] = global.get_pointer();
                getVirtualPointer().notify_absolute_motion(
                    Clutter.get_current_event_time(),
                    x, y);

                getVirtualPointer().notify_button(Clutter.get_current_event_time(),
                    Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
                getVirtualPointer().notify_button(Clutter.get_current_event_time(),
                    Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
            }
        });
    }

    activateDndTarget(zone, first) {
        function mkZoneActor(props) {
            let actor = new St.Widget({style_class: "tile-preview"});
            actor.x = props.x ?? 0
            actor.y = props.y ?? 0;
            actor.width = props.width ?? 0;
            actor.height = props.height ?? 0;
            return actor;
        }

        zone.actor = mkZoneActor({...zone.actorParams});

        this.dndTarget = zone;
        this.zoneActors.add(zone.actor);

        let params = {
            time: Settings.prefs.animation_time,
            [zone.originProp]: zone.center - zone.marginA,
            [zone.sizeProp]: zone.marginA + zone.marginB,
        };

        if (first) {
            params.height = zone.actor.height
            params.y = zone.actor.y

            let clone = this.window.clone;
            let space = zone.space;
            let [x, y] = space.globalToScroll(...clone.get_transformed_position())
            zone.actor.set_position(x, y)
            zone.actor.set_size(...clone.get_transformed_size())
        } else {
            zone.actor[zone.sizeProp] = 0;
            zone.actor[zone.originProp] = zone.center;
        }

        zone.space.cloneContainer.add_child(zone.actor);
        zone.space.selection.hide();
        zone.actor.show();
        Module.Utils().actor_raise(zone.actor);
        Easer.addEase(zone.actor, params);
    }

    deactivateDndTarget(zone) {
        if (zone) {
            zone.space.selection.show();
            Easer.addEase(zone.actor, {
                time: Settings.prefs.animation_time,
                [zone.originProp]: zone.center,
                [zone.sizeProp]: 0,
                onComplete: () => { zone.actor.destroy(); this.zoneActors.delete(zone.actor); }
            });
        }

        this.dndTarget = null;
    }
};

var ResizeGrab = class ResizeGrab {
    constructor(metaWindow, type) {
        this.window = metaWindow;
        this.signals = Module.Signals();

        this.space = Module.Tiling().spaces.spaceOfWindow(metaWindow);
        if (this.space.indexOf(metaWindow) === -1)
            return;

        this.scrollAnchor = metaWindow.clone.targetX + this.space.monitor.x;

        this.signals.connect(metaWindow, 'size-changed', () => {
            metaWindow._targetWidth = null;
            metaWindow._targetHeight = null;
            let frame = metaWindow.get_frame_rect();

            this.space.targetX = frame.x - this.scrollAnchor;
            this.space.cloneContainer.x = this.space.targetX;
            this.space.layout(false);
        })
    }
    end() {
        this.signals.destroy();

        this.window = null;
        this.space.layout();
    }
};
