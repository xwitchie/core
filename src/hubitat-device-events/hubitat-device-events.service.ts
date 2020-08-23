/**
 * @packageDocumentation
 * @module HubitatDeviceEvents
 */

import { Injectable } from '@nestjs/common';
import { Automation } from '../automations/automation';
import { AutomationsService } from '../automations/automations.service';
import { IEventsService } from '../automations/events-service.interface';
import { TriggerDefinition } from '../automations/trigger-definition';
import { all } from '../common/collections-helpers';
import { SubscribersMap } from '../common/subscribers-map';
import { SubscribersSet } from '../common/subscribers-set';
import { HUBITAT_DEVICE_EVENT_TYPE, HubitatDeviceEvent } from './hubitat-device-event';
import { AttributeFilter } from './trigger-definition/attribute-filter';
import { ChangeFilter } from './trigger-definition/change-filter';
import { HubitatDeviceTriggerDefinition } from './trigger-definition/hubitat-device-trigger.definition';

/**
 * An events service handling hubitat device events.
 */
@Injectable()
export class HubitatDeviceEventsService implements IEventsService {
  /**
   * A map of automations sets subscribed by device id.
   * @private
   */
  private subscriptionsByDeviceId: SubscribersMap<number, Automation> = new SubscribersMap<number, Automation>();

  /**
   * A map of automations sets subscribed by attribute name.
   * @private
   */
  private subscriptionsByAttributeName: SubscribersMap<string, Automation> = new SubscribersMap<string, Automation>();

  /**
   * A set of automations subscribed to all hubitat device events.
   * @private
   */
  private subscriptionsOfAllEvents: SubscribersSet<Automation> = new SubscribersSet<Automation>();

  /**
   * A set of all subscribed automations.
   * @private
   */
  private subscribedAutomations: Set<Automation> = new Set<Automation>();

  constructor(private readonly automationsService: AutomationsService) {
    automationsService.registerEventsService(this);
  }

  /**
   * Method handling new hubitat device events. It's responsible for routing
   * the event to matching automations.
   * @param event
   */
  public handleEvent(event: HubitatDeviceEvent): void {
    // Handle only device update user-automations-module
    if (event.eventType !== HUBITAT_DEVICE_EVENT_TYPE) return;

    // Create working copy of all subscribing user-automations
    const unhandledAutomations = new Set(this.subscribedAutomations);

    const runMatchingAutomation = (automation: Automation) => {
      if (!unhandledAutomations.has(automation)) return;
      if (!this.matchEvent(automation, event)) return;
      unhandledAutomations.delete(automation);
      try {
        automation.handleEvent(event);
      } catch (e) {
        console.error(`Error occurred in the "${automation.name}" automation: ${e}`);
        throw new Error(`The automation "${automation.name}" failed to handle event: ${JSON.stringify(event)}`);
      }
    };

    // Handle the 'subscribed to all user-automations-module' user-automations
    for (const automation of this.subscriptionsOfAllEvents) {
      runMatchingAutomation(automation);
    }

    // Handle the 'subscribed to all user-automations-module of a device' user-automations
    const subscribersSetForDevices = this.subscriptionsByDeviceId.getSet(event.deviceId);
    if (subscribersSetForDevices != null) {
      for (const automation of subscribersSetForDevices) {
        runMatchingAutomation(automation);
      }
    }

    // Handle the 'subscribed to attribute name only' user-automations
    const subscribersSetForAttributeOnly = this.subscriptionsByAttributeName.getSet(event.attributeName);
    if (subscribersSetForAttributeOnly != null) {
      for (const automation of subscribersSetForAttributeOnly) {
        runMatchingAutomation(automation);
      }
    }
  }

  /**
   * Registers provided automation by automatically subscribing to event types
   * described by trigger definitions.
   * @param automation Automation to subscribe.
   */
  public registerAutomation(automation: Automation): void {
    // Don't allow registering of same automation twice.
    if (this.subscribedAutomations.has(automation)) {
      throw new Error(`The "${automation.name}" automation is already registered. Consider unregistering first.`);
    }

    const triggers = this.getCompatibleTriggers(automation.builtTriggers);
    if (triggers.length < 1) return;

    for (const trigger of triggers) {
      // All user-automations-module
      if (trigger.devices.length === 0 && trigger.attributes.length === 0) {
        this.subscribedAutomations.add(automation);
        this.subscriptionsOfAllEvents.subscribe(automation);
      }
      // HubitatDevice id user-automations-module
      else if (trigger.devices.length > 0) {
        this.subscribedAutomations.add(automation);
        for (const deviceId of trigger.devices) {
          this.subscriptionsByDeviceId.subscribe(deviceId, automation);
        }
      }
      // Attribute name user-automations-module
      else if (trigger.attributes.length > 0) {
        this.subscribedAutomations.add(automation);
        for (const attributeName of trigger.allAttributeNames) {
          this.subscriptionsByAttributeName.subscribe(attributeName, automation);
        }
      }
    }
  }

  /**
   * Unregisters provided automation by automatically unsubscribing from event
   * types described by trigger definitions.
   * @param automation Automation to unsubscribe.
   */
  public unregisterAutomation(automation: Automation): void {
    const triggers = this.getCompatibleTriggers(automation.builtTriggers);
    for (const trigger of triggers) {
      // All user-automations-module
      if (trigger.devices.length === 0 && trigger.attributes.length === 0) {
        this.subscriptionsOfAllEvents.unsubscribe(automation);
      }
      // HubitatDevice id user-automations-module
      else if (trigger.devices.length > 0) {
        for (const deviceId of trigger.devices) {
          this.subscriptionsByDeviceId.unsubscribe(deviceId, automation);
        }
      }
      // Attribute name user-automations-module
      else if (trigger.attributes.length > 0) {
        for (const attributeName of trigger.allAttributeNames) {
          this.subscriptionsByAttributeName.unsubscribe(attributeName, automation);
        }
      }
    }
    this.recreateSubscribedAutomationsSet();
  }

  private getCompatibleTriggers(triggerDefinitions: TriggerDefinition[]): HubitatDeviceTriggerDefinition[] {
    const validTriggers = triggerDefinitions.filter((trigger) => trigger.triggerType === HUBITAT_DEVICE_EVENT_TYPE);
    return validTriggers as HubitatDeviceTriggerDefinition[];
  }

  /**
   * Recreates subscribedAutomationsSet set from scratch by analyzing all
   * subscriptions.
   */
  private recreateSubscribedAutomationsSet(): void {
    const automations = new Set<Automation>(this.subscriptionsOfAllEvents);
    const deviceIdAutomations = this.subscriptionsByDeviceId.getSubscribers();
    const deviceAttributeNameAutomations = this.subscriptionsByAttributeName.getSubscribers();
    this.subscribedAutomations = new Set([...automations, ...deviceIdAutomations, ...deviceAttributeNameAutomations]);
  }

  private matchEvent(automation: Automation, event: HubitatDeviceEvent): boolean {
    const triggers = this.getCompatibleTriggers(automation.builtTriggers);
    for (const trigger of triggers) {
      if (trigger.devices.length === 0) {
        // All user-automations-module accepted:
        if (trigger.attributes.length === 0) {
          return true;
        }
        // Attribute user-automations-module accepted:
        if (this.matchAttributes(trigger, event)) return true;
      } else if (this.matchDevice(trigger, event)) return true;
    }
    return false;
  }

  private matchDevice(trigger: HubitatDeviceTriggerDefinition, event: HubitatDeviceEvent): boolean {
    if (!trigger.devices.includes(event.deviceId)) return false;
    if (trigger.attributes.length === 0) return true;
    return this.matchAttributes(trigger, event);
  }

  private matchAttributes(trigger: HubitatDeviceTriggerDefinition, event: HubitatDeviceEvent): boolean {
    for (const attributeFilter of trigger.attributes) {
      if (!attributeFilter.attributeNames.includes(event.attributeName)) continue;
      if (this.matchGroups(attributeFilter, event)) return true;
    }
    return false;
  }

  private matchGroups(attributeFilter: AttributeFilter, event: HubitatDeviceEvent): boolean {
    for (const changeGroup of attributeFilter.changeGroups) {
      if (all(changeGroup.filters, (filter) => this.matchFilter(filter, event))) {
        return true;
      }
    }
    return false;
  }

  private matchFilter(filter: ChangeFilter, event: HubitatDeviceEvent): boolean {
    switch (filter.name) {
      case 'changes':
        return true;
      case 'is':
        return event.newValue === `${filter.value}`;
      case 'is-not':
        return event.newValue !== `${filter.value}`;
      case 'was':
        return event.previousValue === `${filter.value}`;
      case 'was-not':
        return event.previousValue !== `${filter.value}`;
      default:
        break;
    }
    return false;
  }
}