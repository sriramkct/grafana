import angular from 'angular';
import castArray from 'lodash/castArray';
import { AppEvents, TimeRange, UrlQueryMap, UrlQueryValue } from '@grafana/data';

import {
  DashboardVariableModel,
  initialVariableModelState,
  OrgVariableModel,
  QueryVariableModel,
  UserVariableModel,
  VariableHide,
  VariableLoadingState,
  VariableModel,
  VariableOption,
  VariableRefresh,
  VariableWithMultiSupport,
  VariableWithOptions,
} from '../types';
import { StoreState, ThunkResult } from '../../../types';
import { getVariable, getVariables } from './selectors';
import { variableAdapters } from '../adapters';
import { Graph } from '../../../core/utils/dag';
import { notifyApp, updateLocation } from 'app/core/actions';
import {
  addVariable,
  changeVariableProp,
  setCurrentVariableValue,
  variableStateCompleted,
  variableStateFailed,
  variableStateFetching,
  variableStateNotStarted,
} from './sharedReducer';
import { toVariableIdentifier, toVariablePayload, VariableIdentifier } from './types';
import { appEvents } from 'app/core/core';
import { contextSrv } from 'app/core/services/context_srv';
import templateSrv from '../../templating/template_srv';
import { alignCurrentWithMulti } from '../shared/multiOptions';
import { isMulti } from '../guard';
import { getTimeSrv } from 'app/features/dashboard/services/TimeSrv';
import { DashboardModel } from 'app/features/dashboard/state';
import { createErrorNotification } from '../../../core/copy/appNotification';
import {
  TransactionStatus,
  variablesClearTransaction,
  variablesCompleteTransaction,
  variablesInitTransaction,
} from './transactionReducer';
import { getBackendSrv } from '../../../core/services/backend_srv';
import { cleanVariables } from './variablesReducer';
import isEqual from 'lodash/isEqual';
import { getCurrentText } from '../utils';
import { store } from 'app/store/store';

// process flow queryVariable
// thunk => processVariables
//    adapter => setValueFromUrl
//      thunk => setOptionFromUrl
//        adapter => updateOptions
//          thunk => updateQueryVariableOptions
//            action => updateVariableOptions
//            action => updateVariableTags
//            thunk => validateVariableSelectionState
//              adapter => setValue
//                thunk => setOptionAsCurrent
//                  action => setCurrentVariableValue
//                  thunk => variableUpdated
//                    adapter => updateOptions for dependent nodes
//        adapter => setValue
//          thunk => setOptionAsCurrent
//            action => setCurrentVariableValue
//            thunk => variableUpdated
//              adapter => updateOptions for dependent nodes
//    adapter => updateOptions
//      thunk => updateQueryVariableOptions
//        action => updateVariableOptions
//        action => updateVariableTags
//        thunk => validateVariableSelectionState
//          adapter => setValue
//            thunk => setOptionAsCurrent
//              action => setCurrentVariableValue
//              thunk => variableUpdated
//                adapter => updateOptions for dependent nodes

export const initDashboardTemplating = (list: VariableModel[]): ThunkResult<void> => {
  return (dispatch, getState) => {
    let orderIndex = 0;
    for (let index = 0; index < list.length; index++) {
      const model = list[index];
      if (!variableAdapters.getIfExists(model.type)) {
        continue;
      }

      dispatch(addVariable(toVariablePayload(model, { global: false, index: orderIndex++, model })));
    }

    templateSrv.updateTimeRange(getTimeSrv().timeRange());

    for (let index = 0; index < getVariables(getState()).length; index++) {
      dispatch(variableStateNotStarted(toVariablePayload(getVariables(getState())[index])));
    }
  };
};

export const addSystemTemplateVariables = (dashboard: DashboardModel): ThunkResult<void> => {
  return (dispatch, getState) => {
    const dashboardModel: DashboardVariableModel = {
      ...initialVariableModelState,
      id: '__dashboard',
      name: '__dashboard',
      type: 'system',
      index: -3,
      skipUrlSync: true,
      hide: VariableHide.hideVariable,
      current: {
        value: {
          name: dashboard.title,
          uid: dashboard.uid,
          toString: () => dashboard.title,
        },
      },
    };

    dispatch(
      addVariable(
        toVariablePayload(dashboardModel, {
          global: dashboardModel.global,
          index: dashboardModel.index,
          model: dashboardModel,
        })
      )
    );

    const orgModel: OrgVariableModel = {
      ...initialVariableModelState,
      id: '__org',
      name: '__org',
      type: 'system',
      index: -2,
      skipUrlSync: true,
      hide: VariableHide.hideVariable,
      current: {
        value: {
          name: contextSrv.user.orgName,
          id: contextSrv.user.orgId,
          toString: () => contextSrv.user.orgId.toString(),
        },
      },
    };

    dispatch(
      addVariable(toVariablePayload(orgModel, { global: orgModel.global, index: orgModel.index, model: orgModel }))
    );

    const userModel: UserVariableModel = {
      ...initialVariableModelState,
      id: '__user',
      name: '__user',
      type: 'system',
      index: -1,
      skipUrlSync: true,
      hide: VariableHide.hideVariable,
      current: {
        value: {
          login: contextSrv.user.login,
          id: contextSrv.user.id,
          toString: () => contextSrv.user.id.toString(),
        },
      },
    };

    dispatch(
      addVariable(toVariablePayload(userModel, { global: userModel.global, index: userModel.index, model: userModel }))
    );
  };
};

export const changeVariableMultiValue = (identifier: VariableIdentifier, multi: boolean): ThunkResult<void> => {
  return (dispatch, getState) => {
    const variable = getVariable<VariableWithMultiSupport>(identifier.id, getState());
    const current = alignCurrentWithMulti(variable.current, multi);

    dispatch(changeVariableProp(toVariablePayload(identifier, { propName: 'multi', propValue: multi })));
    dispatch(changeVariableProp(toVariablePayload(identifier, { propName: 'current', propValue: current })));
  };
};

export const processVariableDependencies = async (variable: VariableModel, state: StoreState) => {
  let dependencies: VariableModel[] = [];

  for (const otherVariable of getVariables(state)) {
    if (variable === otherVariable) {
      continue;
    }

    if (variableAdapters.getIfExists(variable.type)) {
      if (variableAdapters.get(variable.type).dependsOn(variable, otherVariable)) {
        dependencies.push(otherVariable);
      }
    }
  }

  if (!isWaitingForDependencies(dependencies, state)) {
    return;
  }

  await new Promise(resolve => {
    const unsubscribe = store.subscribe(() => {
      if (!isWaitingForDependencies(dependencies, store.getState())) {
        unsubscribe();
        resolve();
      }
    });
  });
};

const isWaitingForDependencies = (dependencies: VariableModel[], state: StoreState): boolean => {
  if (dependencies.length === 0) {
    return false;
  }

  const variables = getVariables(state);
  const notCompletedDependencies = dependencies.filter(d =>
    variables.some(
      v => v.id === d.id && (v.state === VariableLoadingState.NotStarted || v.state === VariableLoadingState.Fetching)
    )
  );

  return notCompletedDependencies.length > 0;
};

export const processVariable = (
  identifier: VariableIdentifier,
  queryParams: UrlQueryMap
): ThunkResult<Promise<void>> => {
  return async (dispatch, getState) => {
    const variable = getVariable(identifier.id, getState());
    await processVariableDependencies(variable, getState());

    const urlValue = queryParams['var-' + variable.name];
    if (urlValue !== void 0) {
      await variableAdapters.get(variable.type).setValueFromUrl(variable, urlValue ?? '');
      return;
    }

    if (variable.hasOwnProperty('refresh')) {
      const refreshableVariable = variable as QueryVariableModel;
      if (
        refreshableVariable.refresh === VariableRefresh.onDashboardLoad ||
        refreshableVariable.refresh === VariableRefresh.onTimeRangeChanged
      ) {
        await dispatch(updateOptions(toVariableIdentifier(refreshableVariable)));
        return;
      }
    }

    // for variables that aren't updated via url or refresh let's simulate the same state changes
    dispatch(variableStateFetching(toVariablePayload(variable)));
    dispatch(variableStateCompleted(toVariablePayload(variable)));
  };
};

export const processVariables = (): ThunkResult<Promise<void>> => {
  return async (dispatch, getState) => {
    const queryParams = getState().location.query;
    const promises = getVariables(getState()).map(
      async (variable: VariableModel) => await dispatch(processVariable(toVariableIdentifier(variable), queryParams))
    );

    await Promise.all(promises);
  };
};

export const setOptionFromUrl = (
  identifier: VariableIdentifier,
  urlValue: UrlQueryValue
): ThunkResult<Promise<void>> => {
  return async (dispatch, getState) => {
    const variable = getVariable(identifier.id, getState());
    if (variable.hasOwnProperty('refresh') && (variable as QueryVariableModel).refresh !== VariableRefresh.never) {
      // updates options
      await dispatch(updateOptions(toVariableIdentifier(variable)));
    }

    // get variable from state
    const variableFromState = getVariable<VariableWithOptions>(variable.id, getState());
    if (!variableFromState) {
      throw new Error(`Couldn't find variable with name: ${variable.name}`);
    }
    // Simple case. Value in url matches existing options text or value.
    let option = variableFromState.options.find(op => {
      return op.text === urlValue || op.value === urlValue;
    });

    if (!option) {
      let defaultText = urlValue as string | string[];
      const defaultValue = urlValue as string | string[];

      if (Array.isArray(urlValue)) {
        // Multiple values in the url. We construct text as a list of texts from all matched options.
        const urlValueArray = urlValue as string[];
        defaultText = urlValueArray.reduce((acc: string[], item: string) => {
          const foundOption = variableFromState.options.find(o => o.value === item);
          if (!foundOption) {
            // @ts-ignore according to strict null errors this can never happen
            // TODO: investigate this further or refactor code
            return [].concat(acc, [item]);
          }

          // @ts-ignore according to strict null errors this can never happen
          // TODO: investigate this further or refactor code
          return [].concat(acc, [foundOption.text]);
        }, []);
      }

      // It is possible that we did not match the value to any existing option. In that case the url value will be
      // used anyway for both text and value.
      option = { text: defaultText, value: defaultValue, selected: false };
    }

    if (isMulti(variableFromState)) {
      // In case variable is multiple choice, we cast to array to preserve the same behaviour as when selecting
      // the option directly, which will return even single value in an array.
      option = alignCurrentWithMulti(
        { text: castArray(option.text), value: castArray(option.value), selected: false },
        variableFromState.multi
      );
    }

    await variableAdapters.get(variable.type).setValue(variableFromState, option);
  };
};

export const selectOptionsForCurrentValue = (variable: VariableWithOptions): VariableOption[] => {
  let i, y, value, option;
  const selected: VariableOption[] = [];

  for (i = 0; i < variable.options.length; i++) {
    option = { ...variable.options[i] };
    option.selected = false;
    if (Array.isArray(variable.current.value)) {
      for (y = 0; y < variable.current.value.length; y++) {
        value = variable.current.value[y];
        if (option.value === value) {
          option.selected = true;
          selected.push(option);
        }
      }
    } else if (option.value === variable.current.value) {
      option.selected = true;
      selected.push(option);
    }
  }

  return selected;
};

export const validateVariableSelectionState = (
  identifier: VariableIdentifier,
  defaultValue?: string
): ThunkResult<Promise<void>> => {
  return (dispatch, getState) => {
    const variableInState = getVariable<VariableWithOptions>(identifier.id, getState());
    const current = variableInState.current || (({} as unknown) as VariableOption);
    const setValue = variableAdapters.get(variableInState.type).setValue;

    if (Array.isArray(current.value)) {
      const selected = selectOptionsForCurrentValue(variableInState);

      // if none pick first
      if (selected.length === 0) {
        const option = variableInState.options[0];
        return setValue(variableInState, option);
      }

      const option: VariableOption = {
        value: selected.map(v => v.value) as string[],
        text: selected.map(v => v.text) as string[],
        selected: true,
      };
      return setValue(variableInState, option);
    }

    let option: VariableOption | undefined | null = null;

    // 1. find the current value
    const text = getCurrentText(variableInState);
    option = variableInState.options?.find(v => v.text === text);
    if (option) {
      return setValue(variableInState, option);
    }

    // 2. find the default value
    if (defaultValue) {
      option = variableInState.options?.find(v => v.text === defaultValue);
      if (option) {
        return setValue(variableInState, option);
      }
    }

    // 3. use the first value
    if (variableInState.options) {
      const option = variableInState.options[0];
      if (option) {
        return setValue(variableInState, option);
      }
    }

    // 4... give up
    return Promise.resolve();
  };
};

export const setOptionAsCurrent = (
  identifier: VariableIdentifier,
  current: VariableOption,
  emitChanges: boolean
): ThunkResult<Promise<void>> => {
  return dispatch => {
    dispatch(setCurrentVariableValue(toVariablePayload(identifier, { option: current })));
    return dispatch(variableUpdated(identifier, emitChanges));
  };
};

const createGraph = (variables: VariableModel[]) => {
  const g = new Graph();

  variables.forEach(v => {
    g.createNode(v.name);
  });

  variables.forEach(v1 => {
    variables.forEach(v2 => {
      if (v1 === v2) {
        return;
      }

      if (variableAdapters.get(v1.type).dependsOn(v1, v2)) {
        g.link(v1.name, v2.name);
      }
    });
  });

  return g;
};

export const variableUpdated = (
  identifier: VariableIdentifier,
  emitChangeEvents: boolean
): ThunkResult<Promise<void>> => {
  return (dispatch, getState) => {
    const variableInState = getVariable(identifier.id, getState());

    // if we're initializing variables ignore cascading update because we are in a boot up scenario
    if (getState().templating.transaction.status === TransactionStatus.Fetching) {
      return Promise.resolve();
    }

    const variables = getVariables(getState());
    const g = createGraph(variables);

    const node = g.getNode(variableInState.name);
    let promises: Array<Promise<any>> = [];
    if (node) {
      promises = node.getOptimizedInputEdges().map(e => {
        const variable = variables.find(v => v.name === e.inputNode.name);
        if (!variable) {
          return Promise.resolve();
        }

        return dispatch(updateOptions(toVariableIdentifier(variable), false));
      });
    }
    return Promise.all(promises).then(() => {
      if (emitChangeEvents) {
        const dashboard = getState().dashboard.getModel();
        dashboard?.processRepeats();
        dispatch(updateLocation({ query: getQueryWithVariables(getState) }));
        dashboard?.startRefresh();
      }
    });
  };
};

export interface OnTimeRangeUpdatedDependencies {
  templateSrv: typeof templateSrv;
  appEvents: typeof appEvents;
}

export const onTimeRangeUpdated = (
  timeRange: TimeRange,
  dependencies: OnTimeRangeUpdatedDependencies = { templateSrv: templateSrv, appEvents: appEvents }
): ThunkResult<Promise<void>> => async (dispatch, getState) => {
  dependencies.templateSrv.updateTimeRange(timeRange);
  const variablesThatNeedRefresh = getVariables(getState()).filter(variable => {
    if (variable.hasOwnProperty('refresh') && variable.hasOwnProperty('options')) {
      const variableWithRefresh = (variable as unknown) as QueryVariableModel;
      return variableWithRefresh.refresh === VariableRefresh.onTimeRangeChanged;
    }

    return false;
  });

  const promises = variablesThatNeedRefresh.map(
    (variable: VariableWithOptions) =>
      new Promise((resolve, reject) => {
        const previousOptions = variable.options.slice();
        dispatch(updateOptions(toVariableIdentifier(variable)))
          .then(() => {
            const updatedVariable = getVariable<VariableWithOptions>(variable.id, getState());
            if (angular.toJson(previousOptions) !== angular.toJson(updatedVariable.options)) {
              const dashboard = getState().dashboard.getModel();
              dashboard?.templateVariableValueUpdated();
            }
            resolve();
          })
          .catch(error => reject(error));
      })
  );

  try {
    await Promise.all(promises);
    const dashboard = getState().dashboard.getModel();
    dashboard?.startRefresh();
  } catch (error) {
    console.error(error);
    dependencies.appEvents.emit(AppEvents.alertError, ['Template variable service failed', error.message]);
  }
};

export const templateVarsChangedInUrl = (vars: UrlQueryMap): ThunkResult<void> => async (dispatch, getState) => {
  const update: Array<Promise<any>> = [];
  for (const variable of getVariables(getState())) {
    const key = `var-${variable.name}`;
    if (vars.hasOwnProperty(key)) {
      if (isVariableUrlValueDifferentFromCurrent(variable, vars[key])) {
        const promise = variableAdapters.get(variable.type).setValueFromUrl(variable, vars[key]);
        update.push(promise);
      }
    }
  }

  if (update.length) {
    await Promise.all(update);
    const dashboard = getState().dashboard.getModel();
    dashboard?.templateVariableValueUpdated();
    dashboard?.startRefresh();
  }
};

const isVariableUrlValueDifferentFromCurrent = (variable: VariableModel, urlValue: any): boolean => {
  // lodash isEqual handles array of value equality checks as well
  return !isEqual(variableAdapters.get(variable.type).getValueForUrl(variable), urlValue);
};

const getQueryWithVariables = (getState: () => StoreState): UrlQueryMap => {
  const queryParams = getState().location.query;

  const queryParamsNew = Object.keys(queryParams)
    .filter(key => key.indexOf('var-') === -1)
    .reduce((obj, key) => {
      obj[key] = queryParams[key];
      return obj;
    }, {} as UrlQueryMap);

  for (const variable of getVariables(getState())) {
    if (variable.skipUrlSync) {
      continue;
    }

    const adapter = variableAdapters.get(variable.type);
    queryParamsNew['var-' + variable.name] = adapter.getValueForUrl(variable);
  }

  return queryParamsNew;
};

export const initVariablesTransaction = (dashboardUid: string, dashboard: DashboardModel): ThunkResult<void> => async (
  dispatch,
  getState
) => {
  try {
    const transactionState = getState().templating.transaction;
    if (transactionState.status === TransactionStatus.Fetching) {
      // previous dashboard is still fetching variables, cancel all requests
      dispatch(cancelVariables());
    }

    // Start init transaction
    dispatch(variablesInitTransaction({ uid: dashboardUid }));
    // Add system variables like __dashboard and __user
    dispatch(addSystemTemplateVariables(dashboard));
    // Load all variables into redux store
    dispatch(initDashboardTemplating(dashboard.templating.list));
    // Process all variable updates
    await dispatch(processVariables());
    // Mark update as complete
    dispatch(variablesCompleteTransaction({ uid: dashboardUid }));
  } catch (err) {
    dispatch(notifyApp(createErrorNotification('Templating init failed', err)));
    console.error(err);
  }
};

export const cleanUpVariables = (): ThunkResult<void> => dispatch => {
  dispatch(cleanVariables());
  dispatch(variablesClearTransaction());
};

type CancelVariablesDependencies = { getBackendSrv: typeof getBackendSrv };
export const cancelVariables = (
  dependencies: CancelVariablesDependencies = { getBackendSrv: getBackendSrv }
): ThunkResult<void> => dispatch => {
  dependencies.getBackendSrv().cancelAllInFlightRequests();
  dispatch(cleanUpVariables());
};

export const updateOptions = (
  identifier: VariableIdentifier,
  awaitUpdateOptions = true
): ThunkResult<Promise<void>> => async (dispatch, getState) => {
  const variableInState = getVariable(identifier.id, getState());

  if (!awaitUpdateOptions) {
    dispatch(variableStateFetching(toVariablePayload(variableInState)));
    return variableAdapters
      .get(variableInState.type)
      .updateOptions(variableInState)
      .then(() => {
        dispatch(variableStateCompleted(toVariablePayload(variableInState)));
      })
      .catch(error => {
        dispatch(variableStateFailed(toVariablePayload(variableInState, { error })));
      });
  }

  try {
    dispatch(variableStateFetching(toVariablePayload(variableInState)));
    await variableAdapters.get(variableInState.type).updateOptions(variableInState);
    dispatch(variableStateCompleted(toVariablePayload(variableInState)));
  } catch (error) {
    console.error(error);
    dispatch(variableStateFailed(toVariablePayload(variableInState, { error })));
    dispatch(notifyApp(createErrorNotification('Templating', 'Error updating options: ' + error.message)));
  }
};
