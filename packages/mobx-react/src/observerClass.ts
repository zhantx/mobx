import { PureComponent, Component, ComponentClass, ClassAttributes } from "react"
import {
    createAtom,
    _allowStateChanges,
    Reaction,
    _allowStateReadsStart,
    _allowStateReadsEnd,
    _getGlobalState,
    IAtom
} from "mobx"
import {
    isUsingStaticRendering,
    _observerFinalizationRegistry as observerFinalizationRegistry
} from "mobx-react-lite"
import { shallowEqual, patch } from "./utils/utils"
// @ts-expect-error
import { runWithPriority } from "react-dom"

const administrationSymbol = Symbol("ObserverAdministration")
const isMobXReactObserverSymbol = Symbol("isMobXReactObserver")

type ObserverAdministration = {
    reaction: Reaction | null // also serves as disposed flag
    forceUpdate: Function | null
    mounted: boolean // we could use forceUpdate as mounted flag
    reactionInvalidatedBeforeMount: boolean
    name: string
    propsAtom: IAtom
    stateAtom: IAtom
    contextAtom: IAtom
    props: any
    state: any
    context: any
    // Setting this.props causes forceUpdate, because this.props is observable.
    // forceUpdate sets this.props.
    // This flag is used to avoid the loop.
    isUpdating: boolean
}

function getAdministration(component: Component): ObserverAdministration {
    // We create administration lazily, because we can't patch constructor
    // and the exact moment of initialization partially depends on React internals.
    // At the time of writing this, the first thing invoked is one of the observable getter/setter (state/props/context).
    return (component[administrationSymbol] ??= {
        reaction: null,
        mounted: false,
        reactionInvalidatedBeforeMount: false,
        forceUpdate: null,
        name: getDisplayName(component.constructor as ComponentClass),
        state: undefined,
        props: undefined,
        context: undefined,
        propsAtom: createAtom("props"),
        stateAtom: createAtom("state"),
        contextAtom: createAtom("context"),
        isUpdating: false
    })
}

export function makeClassComponentObserver(
    componentClass: ComponentClass<any, any>
): ComponentClass<any, any> {
    const { prototype } = componentClass

    if (componentClass[isMobXReactObserverSymbol]) {
        const displayName = getDisplayName(componentClass)
        console.warn(
            `The provided component class (${displayName}) has already been declared as an observer component.`
        )
    } else {
        componentClass[isMobXReactObserverSymbol] = true
    }

    if (prototype.componentWillReact) {
        throw new Error("The componentWillReact life-cycle event is no longer supported")
    }
    if (componentClass["__proto__"] !== PureComponent) {
        if (!prototype.shouldComponentUpdate) {
            prototype.shouldComponentUpdate = observerSCU
        } else if (prototype.shouldComponentUpdate !== observerSCU) {
            // n.b. unequal check, instead of existence check, as @observer might be on superclass as well
            throw new Error(
                "It is not allowed to use shouldComponentUpdate in observer based components."
            )
        }
    }

    // this.props and this.state are made observable, just to make sure @computed fields that
    // are defined inside the component, and which rely on state or props, re-compute if state or props change
    // (otherwise the computed wouldn't update and become stale on props change, since props are not observable)
    // However, this solution is not without it's own problems: https://github.com/mobxjs/mobx-react/issues?utf8=%E2%9C%93&q=is%3Aissue+label%3Aobservable-props-or-not+
    Object.defineProperties(prototype, {
        props: observablePropsDescriptor,
        state: observableStateDescriptor,
        context: observableContextDescriptor
    })

    const originalRender = prototype.render
    if (typeof originalRender !== "function") {
        const displayName = getDisplayName(componentClass)
        throw new Error(
            `[mobx-react] class component (${displayName}) is missing \`render\` method.` +
                `\n\`observer\` requires \`render\` being a function defined on prototype.` +
                `\n\`render = () => {}\` or \`render = function() {}\` is not supported.`
        )
    }

    if (__DEV__) {
        // Backwards compatibility for testing-library/react
        prototype.render = function () {
            this.render = isUsingStaticRendering()
                ? originalRender
                : createReactiveRender.call(this, originalRender)
            return this.render()
        }
    } else {
        prototype.render = function () {
            Object.defineProperty(this, "render", {
                // There is no safe way to replace render, therefore it's forbidden.
                configurable: false,
                writable: false,
                value: isUsingStaticRendering()
                    ? originalRender
                    : createReactiveRender.call(this, originalRender)
            })
            return this.render()
        }
    }

    patch(prototype, "componentDidMount", function () {
        // `componentDidMount` may not be called at all. React can abandon the instance after `render`.
        // That's why we use finalization registry to dispose reaction created during render.
        // Happens with `<Suspend>` see #3492
        //
        // `componentDidMount` can be called immediately after `componentWillUnmount` without calling `render` in between.
        // Happens with `<StrictMode>`see #3395.
        //
        // If `componentDidMount` is called, it's guaranteed to run synchronously with render (similary to `useLayoutEffect`).
        // Therefore we don't have to worry about external (observable) state being updated before mount (no state version checking).
        //
        // Things may change: "In the future, React will provide a feature that lets components preserve state between unmounts"

        const admin = getAdministration(this)

        admin.mounted = true

        // Component instance committed, prevent reaction disposal.
        observerFinalizationRegistry.unregister(this)

        // We don't set forceUpdate before mount because it requires a reference to `this`,
        // therefore `this` could NOT be garbage collected before mount,
        // preventing reaction disposal by FinalizationRegistry and leading to memory leak.
        // As an alternative we could have `admin.instanceRef = new WeakRef(this)`, but lets avoid it if possible.
        admin.forceUpdate = () => this.forceUpdate()

        if (!admin.reaction || admin.reactionInvalidatedBeforeMount) {
            // Missing reaction:
            // 1. Instance was unmounted (reaction disposed) and immediately remounted without running render #3395.
            // 2. Reaction was disposed by finalization registry before mount. Shouldn't ever happen for class components:
            // `componentDidMount` runs synchronously after render, but our registry are deferred (can't run in between).
            // In any case we lost subscriptions to observables, so we have to create new reaction and re-render to resubscribe.
            // The reaction will be created lazily by following render.

            // Reaction invalidated before mount:
            // 1. A descendant's `componenDidMount` invalidated it's parent #3730
            admin.forceUpdate()
        }
    })

    patch(prototype, "componentWillUnmount", function () {
        if (isUsingStaticRendering()) {
            return
        }
        const admin = getAdministration(this)
        admin.reaction?.dispose()
        admin.reaction = null
        admin.forceUpdate = null
        admin.mounted = false
        admin.reactionInvalidatedBeforeMount = false
    })

    return componentClass
}

// Generates a friendly name for debugging
function getDisplayName(componentClass: ComponentClass) {
    return componentClass.displayName || componentClass.name || "<component>"
}

function createReactiveRender(originalRender: any) {
    const boundOriginalRender = originalRender.bind(this)

    const admin = getAdministration(this)

    function reactiveRender() {
        if (!admin.reaction) {
            // Create reaction lazily to support re-mounting #3395
            admin.reaction = createReaction(admin)
            if (!admin.mounted) {
                // React can abandon this instance and never call `componentDidMount`/`componentWillUnmount`,
                // we have to make sure reaction will be disposed.
                observerFinalizationRegistry.register(this, admin, this)
            }
        }

        let error: unknown = undefined
        let renderResult = undefined
        admin.reaction.track(() => {
            try {
                // TODO@major
                // Optimization: replace with _allowStateChangesStart/End (not available in mobx@6.0.0)
                renderResult = _allowStateChanges(false, boundOriginalRender)
            } catch (e) {
                error = e
            }
        })
        if (error) {
            throw error
        }
        return renderResult
    }

    return reactiveRender
}

function createReaction(admin: ObserverAdministration) {
    return new Reaction(`${admin.name}.render()`, () => {
        if (admin.isUpdating) {
            // Reaction is suppressed when setting new state/props/context,
            // this is when component is already being updated.
            return
        }

        if (!admin.mounted) {
            // This is neccessary to avoid react warning about calling forceUpdate on component that isn't mounted yet.
            // This happens when component is abandoned after render - our reaction is already created and reacts to changes.
            // `componenDidMount` runs synchronously after `render`, so unlike functional component, there is no delay during which the reaction could be invalidated.
            // However `componentDidMount` runs AFTER it's descendants' `componentDidMount`, which CAN invalidate the reaction, see #3730. Therefore remember and forceUpdate on mount.
            admin.reactionInvalidatedBeforeMount = true
            return
        }

        try {
            // forceUpdate sets new `props`, since we made it observable, it would `reportChanged`, causing a loop.
            admin.isUpdating = true
            admin.forceUpdate && runWithPriority(1, admin.forceUpdate)
        } catch (error) {
            admin.reaction?.dispose()
            admin.reaction = null
        } finally {
            admin.isUpdating = false
        }
    })
}

function observerSCU(nextProps: ClassAttributes<any>, nextState: any): boolean {
    if (isUsingStaticRendering()) {
        console.warn(
            "[mobx-react] It seems that a re-rendering of a React component is triggered while in static (server-side) mode. Please make sure components are rendered only once server-side."
        )
    }
    // update on any state changes (as is the default)
    if (this.state !== nextState) {
        return true
    }
    // update if props are shallowly not equal, inspired by PureRenderMixin
    // we could return just 'false' here, and avoid the `skipRender` checks etc
    // however, it is nicer if lifecycle events are triggered like usually,
    // so we return true here if props are shallowly modified.
    return !shallowEqual(this.props, nextProps)
}

function createObservablePropDescriptor(key: "props" | "state" | "context") {
    const atomKey = `${key}Atom`
    return {
        configurable: true,
        enumerable: true,
        get() {
            const admin = getAdministration(this)

            let prevReadState = _allowStateReadsStart(true)

            admin[atomKey].reportObserved()

            _allowStateReadsEnd(prevReadState)

            return admin[key]
        },
        set(value) {
            const admin = getAdministration(this)
            // forceUpdate issued by reaction sets new props.
            // It sets isUpdating to true to prevent loop.
            if (!admin.isUpdating && !shallowEqual(admin[key], value)) {
                admin[key] = value
                // This notifies all observers including our component,
                // but we don't want to cause `forceUpdate`, because component is already updating,
                // therefore supress component reaction.
                admin.isUpdating = true
                admin[atomKey].reportChanged()
                admin.isUpdating = false
            } else {
                admin[key] = value
            }
        }
    }
}

const observablePropsDescriptor = createObservablePropDescriptor("props")
const observableStateDescriptor = createObservablePropDescriptor("state")
const observableContextDescriptor = createObservablePropDescriptor("context")
